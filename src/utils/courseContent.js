const limits = require('../config/courseLimits');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const positiveId = value => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid identifier');
    return id;
};
function validateMetadata(body) {
    // Multipart forms encode newlines as CRLF; JSON edits usually use LF.
    // Normalize before counting so identical paragraphs have identical limits.
    const title = typeof body.title === 'string' ? body.title.replace(/\r\n?/g, '\n') : null;
    const description = typeof body.description === 'string' ? body.description.replace(/\r\n?/g, '\n') : null;
    if (title === null || !title.trim() || [...title].length > limits.maxTitleCharacters)
        fail(400, `Video title must contain 1–${limits.maxTitleCharacters} characters`);
    if (description === null || [...description].length > limits.maxDescriptionCharacters)
        fail(400, `Description must contain at most ${limits.maxDescriptionCharacters.toLocaleString('en-US')} characters`);
    return { title, description };
}
function validateUpload(videos, size) {
    if (videos.length >= limits.maxVideos) fail(409, `A course can contain at most ${limits.maxVideos} videos`);
    if (!Number.isFinite(size) || size <= 0 || size > limits.maxVideoBytes) fail(400, 'Each video must be no larger than 1 GB');
}
function validateOrder(videos, ids) {
    if (videos.some(video => Number(video.approved) === 1)) fail(409, 'Lesson order is locked once any video is approved');
    if (!Array.isArray(ids)) fail(400, 'Provide the complete lesson order');
    const order = ids.map(positiveId);
    if (order.length !== videos.length || new Set(order).size !== order.length ||
        order.some(id => !videos.some(video => Number(video.id) === id)))
        fail(409, 'Lessons changed. Reload and submit every lesson exactly once');
    return order;
}
async function ownedCourse(db, scholarId, subjectId) {
    const [rows] = await db.query(`SELECT ss.*, s.name AS course_name FROM scholar_subjects ss
        JOIN scholar_profile sp ON sp.user_id = ss.scholar_user_id
        JOIN subjects s ON s.id = ss.subject_id
        WHERE ss.scholar_user_id = ? AND ss.subject_id = ? AND ss.approved = 1 AND sp.approved = 1`,
    [scholarId, positiveId(subjectId)]);
    if (!rows.length) fail(403, 'An approved course application belonging to you is required');
    return rows[0];
}
async function courseVideos(db, scholarId, subjectId) {
    const [rows] = await db.query(`SELECT * FROM videos WHERE scholar_user_id = ? AND subject_id = ? ORDER BY sequence_index, id`, [scholarId, subjectId]);
    return rows;
}
// Content mutations share this short database lock; release it before provider I/O.
async function withCourseLock(pool, scholarId, subjectId, work) {
    const key = `uniclips:course:${positiveId(scholarId)}:${positiveId(subjectId)}`;
    const db = await pool.getConnection();
    let locked = false;
    try {
        const [[result]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
        locked = Number(result.acquired) === 1;
        if (!locked) fail(409, 'This course is being updated. Please try again shortly');
        return await work(db);
    } finally {
        try { if (locked) await db.query('SELECT RELEASE_LOCK(?)', [key]); }
        finally { db.release(); }
    }
}
async function reorder(db, scholarId, subjectId, ids) {
    await ownedCourse(db, scholarId, subjectId);
    const videos = await courseVideos(db, scholarId, subjectId);
    const order = validateOrder(videos, ids);
    await db.beginTransaction();
    try {
        // Vacate positive positions first, also compatible with a future unique index.
        await db.query('UPDATE videos SET sequence_index = -id WHERE scholar_user_id = ? AND subject_id = ?', [scholarId, subjectId]);
        for (let i = 0; i < order.length; i++) {
            await db.query('UPDATE videos SET sequence_index = ? WHERE id = ? AND scholar_user_id = ? AND subject_id = ?', [i + 1, order[i], scholarId, subjectId]);
        }
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
}
module.exports = { fail, positiveId, validateMetadata, validateUpload, validateOrder, ownedCourse, courseVideos, withCourseLock, reorder };
