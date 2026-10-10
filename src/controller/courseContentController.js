const { pool } = require('../config/db');
const limits = require('../config/courseLimits');
const { ownedCourse, courseVideos, withCourseLock, reorder, validateMetadata, fail } = require('../utils/courseContent');
const respond = (res, error) => res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to update course content' });
const wf=require('../services/courseWorkflow');

async function getCourseContent(req, res) {
    try {
        const course = await ownedCourse(pool, req.user.id, req.params.subjectId);
        const videos = await courseVideos(pool, req.user.id, course.subject_id);
        const state=await wf.workflow(pool,course.id);
        const editable=wf.EDITABLE.has(state.state);
        res.json({ course, videos, limits, workflow:state, editable, orderLocked: !editable || videos.some(v => Number(v.approved) === 1) });
    } catch (error) { respond(res, error); }
}
async function reorderCourse(req, res) {
    try {
        await withCourseLock(pool, req.user.id, req.params.subjectId,
            db => reorder(db, req.user.id, req.params.subjectId, req.body.videoIds));
        res.json({ message: 'Lesson order saved' });
    } catch (error) { respond(res, error); }
}
async function editVideo(req, res) {
    try {
        const metadata = validateMetadata(req.body);
        const [[video]] = await pool.query('SELECT * FROM videos WHERE id = ? AND scholar_user_id = ?', [req.params.id, req.user.id]);
        if (!video) fail(404, 'Video not found');
        await withCourseLock(pool, req.user.id, video.subject_id, async db => {
            const {offering}=await wf.editable(db, req.user.id, video.subject_id);
            await db.beginTransaction();
            try {
            const [result] = await db.query(`UPDATE videos SET title = ?, description = ?
                WHERE id = ? AND scholar_user_id = ? AND approved = 0`, [metadata.title, metadata.description, video.id, req.user.id]);
            if (!result.affectedRows) fail(409, 'Approved videos cannot be edited');
            await wf.touch(db,offering.id);
            await db.commit();
            } catch(error){await db.rollback();throw error;}
        });
        res.json({ message: 'Video details saved for admin review' });
    } catch (error) { respond(res, error); }
}
module.exports = { getCourseContent, reorderCourse, editVideo };
