const { VideoModel } = require("../models/videos");
const vimeoClient = require("../config/vimeo");
const fs = require("fs");

const { pool } = require('../config/db');
const { annotateCourses } = require('../utils/generalCourses');
const { ownedCourse, courseVideos, withCourseLock, validateUpload, validateMetadata, fail } = require('../utils/courseContent');
const {createContentAuthorization,publicLesson}=require('../services/contentAuthorization');
const contentAccess=createContentAuthorization(pool);
const readiness=require('../services/videoReadiness').sharedVideoReadiness(vimeoClient);
const {INITIAL_PRIVACY,sharedVimeoPrivacy}=require('../services/vimeoPrivacy');
const privacy=sharedVimeoPrivacy(vimeoClient);
const workflow=require('../services/courseWorkflow');
const courseWorkflow=workflow.createCourseWorkflow(pool,readiness);
const submitCourse=async(req,res)=>{try{const offering=await ownedCourse(pool,req.user.id,req.params.subjectId);res.json(await courseWorkflow.transition(req.user,offering.id,'submit'));}catch(error){contentError(res,error);}};
const reviewReadiness=async(req,res)=>{try{
 const result=await contentAccess.playback(req.user,req.params.id);
 if(!result.ownerAccess&&!result.operationalAccess)return res.status(403).json({message:'Review permission required'});
 const state=await readiness.read(result.video.player_url,{fresh:true});
 res.json({...state,...(state.state==='READY'&&state.policyVerified===true?{player_url:result.video.player_url}:{})});
}catch(error){contentError(res,error);}};
const contentError=(res,error)=>{
  require('../utils/safeLogging').logError('Content request denied or unavailable',error);
  return res.status(error.status||503).json({message:error.status?error.message:'Content is temporarily unavailable'});
};
const getLearnerCourse=async(req,res)=>{
  try{res.json(await contentAccess.course(req.user,req.params.subjectId,req.params.scholarId));}
  catch(error){contentError(res,error);}
};
const requireCurrentScholar=async(req,res,next)=>{try{await contentAccess.requireScholar(req.user);next();}catch(error){contentError(res,error);}};

const uploadVideo = async (req, res) => {
  if (req.uploadState) req.uploadState.processing = true;
  let providerCompleted = false;
  let receipt;
  let reservation;
  try {
    if (!req.file) return res.status(400).json({ message: 'No video file received' });
    const { title, description } = validateMetadata(req.body);
    const scholarId = req.user.id, subjectId = req.uploadSubjectId;
    if (req.body.subjectId !== undefined && Number(req.body.subjectId) !== subjectId) fail(400, 'Upload course does not match the authorized target');
    const sequence = await withCourseLock(pool, scholarId, subjectId, async db => {
      await db.beginTransaction();
      try{reservation=await courseWorkflow.reserve(db,scholarId,subjectId,req.file.size);await db.commit();return reservation.sequence;}
      catch(error){await db.rollback();throw error;}
    });
    // The advisory lock and its connection have been released before provider I/O.
    receipt = await require('../utils/uploadRecovery').startReceipt(scholarId, subjectId);
    const uri = await new Promise((resolve, reject) => {
      vimeoClient.upload(req.file.path, { name: `UniClips upload ${reservation.id} course ${subjectId} lesson ${sequence}`, description: 'Lesson details are managed in UniClips.', privacy: { ...INITIAL_PRIVACY } },
        resolve, () => {}, () => reject(new Error('Vimeo upload failed')));
    });
    providerCompleted = true;
    if (typeof uri !== 'string' || !/^\/videos\/[0-9]+$/.test(uri)) throw new Error('Invalid provider response');
    await receipt.completed(uri);
    const vimeoId = uri.slice('/videos/'.length), videoUrl = `https://vimeo.com/${vimeoId}`;
    // No connection is held. Failed/ambiguous policy work retains the durable reservation.
    const verified=await privacy.configureNew(videoUrl);
    if(verified.policyVerified!==true)throw new Error('Video security verification unavailable');
    await withCourseLock(pool, scholarId, subjectId, async db => {
      await workflow.editable(db, scholarId, subjectId);
      const videos = await courseVideos(db, scholarId, subjectId);
      validateUpload(videos, req.file.size);
      const currentSequence = Math.max(0, ...videos.map(v => Number(v.sequence_index))) + 1;
      await db.beginTransaction();try{
      await db.query(`INSERT INTO videos (scholar_user_id, subject_id, title, description, video_url, price, is_free, sequence_index)
        VALUES (?, ?, ?, ?, ?, 0, 1, ?)`, [scholarId, subjectId, title, description, videoUrl, currentSequence]);
      await courseWorkflow.finish(db,reservation);await db.commit();
      }catch(error){await db.rollback();throw error;}
    });
    await receipt.recorded().catch(error => require('../utils/safeLogging').logError('Upload receipt cleanup failed', error));
    res.status(201).json({ message: 'Upload accepted. Playback readiness will be checked in course review.', uploadAccepted:true, videoUrl, vimeoId });
  } catch (error) {
    // A completed transfer with failed persistence needs owner reconciliation;
    // do not retry/delete remote media automatically after an ambiguous DB result.
    require('../utils/safeLogging').logError(providerCompleted ? 'Video persistence requires reconciliation' : 'Video upload failed', error);
    // An ambiguous transfer is never retried, deleted or automatically unlocked.
    await courseWorkflow.ambiguous(reservation).catch(()=>{});
    const status = providerCompleted ? 503 : error.status || 500;
    res.status(status).json({ message: providerCompleted ? 'Transfer completed but could not be recorded. Contact support before retrying.' : error.status ? error.message : 'Unable to upload video. Please contact support before retrying if the transfer completed.', ...(receipt ? { uploadReference: receipt.id } : {}) });
  } finally {
    if (req.uploadState) await req.uploadState.finish();
    else if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
  }
};

// Get single video
const getVideo = async (req, res) => {
  try {
    const result=await contentAccess.playback(req.user,req.params.id,req.query.subjectId,req.query.scholarId);
    const verified=await readiness.read(result.video.player_url,{fresh:true});
    if(verified.state!=='READY'||verified.policyVerified!==true)fail(503,'Playback is temporarily unavailable');
    res.json(result.video);
  } catch (err) {
    contentError(res,err);
  }
};

// List videos by subject
const listVideosBySubject = async (req, res) => {
  try {
    const result=await contentAccess.course(req.user,req.params.subjectId,req.query.scholarId);
    res.json(result.videos);
  } catch (err) {
    contentError(res,err);
  }
};

// Watch video
const watchVideo = getVideo;

// Get all videos
const getAllVideos = async (req, res) => {
  try {
    const [videos] = await VideoModel.getAllVideos();
    const annotated = await annotateCourses(pool, videos.map(publicLesson));
    res.status(200).json({ videos: req.query.category === 'general'
      ? annotated.filter(video => video.is_general_university_course) : annotated });
  } catch (err) {
    contentError(res,err);
  }
};

// Get scholar's own videos
const getScholarVideos = async (req, res) => {
  try {
    const scholarId = req.user.id;
    await contentAccess.requireScholar(req.user);
    const [videos] = await VideoModel.findByScholar(scholarId);
    res.status(200).json({ videos });
  } catch (err) {
    contentError(res,err);
  }
};

// Approve video with price (Admin only)
const approveVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const { price } = req.body;
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    const video = rows[0];
    const finalPrice = await withCourseLock(pool, video.scholar_user_id, video.subject_id, async db => {
      const [[current]] = await db.query('SELECT * FROM videos WHERE id = ?', [videoId]);
      if (!current) fail(404, 'Video not found');
      const amount = Number(current.sequence_index) === 1 ? 0 : Number(price || 0);
      if (!Number.isFinite(amount) || amount < 0) fail(400, 'Invalid price');
      await db.query('UPDATE videos SET approved = 1, price = ?, is_free = ? WHERE id = ?', [amount, amount === 0 ? 1 : 0, videoId]);
      return amount;
    });

    res.status(200).json({ 
      message: "Video approved successfully",
      price: finalPrice
    });
  } catch (err) {
    console.error("Error approving video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error approving video" });
  }
};

// Delete/Reject video (Admin only)
const deleteVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    await withCourseLock(pool, rows[0].scholar_user_id, rows[0].subject_id, async db => {
      await db.query('DELETE FROM videos WHERE id = ?', [videoId]);
    });
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error deleting video" });
  }
};

// Delete video by scholar (only their own)
const deleteVideoByScholar = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const scholarId = req.user.id;
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists and belongs to this scholar
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    if (rows[0].scholar_user_id !== scholarId) {
      return res.status(403).json({ message: "You can only delete your own videos" });
    }

    await withCourseLock(pool, scholarId, rows[0].subject_id, async db => {
      const {offering}=await workflow.editable(db, scholarId, rows[0].subject_id);
      await db.beginTransaction();try{
      const [result] = await db.query('DELETE FROM videos WHERE id = ? AND scholar_user_id = ? AND approved = 0', [videoId, scholarId]);
      if (!result.affectedRows) fail(409, 'Approved videos cannot be deleted by scholars');
      await workflow.touch(db,offering.id);await db.commit();
      }catch(error){await db.rollback();throw error;}
    });
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error deleting video" });
  }
};

// Get all videos for admin (including unapproved)
const getAllVideosAdmin = async (req, res) => {
  try {
    const [videos] = await VideoModel.getAllVideosAdmin();
    res.status(200).json({ videos });
  } catch (err) {
    console.error("Error fetching admin videos:", err);
    res.status(500).json({ message: "Server error fetching videos" });
  }
};

module.exports = {
  submitCourse,reviewReadiness,
  uploadVideo,
  getVideo,
  listVideosBySubject,
  watchVideo,
  getAllVideos,
  getAllVideosAdmin,
  getLearnerCourse,
  requireCurrentScholar,
  getScholarVideos,
  approveVideo,
  deleteVideo,
  deleteVideoByScholar
};
