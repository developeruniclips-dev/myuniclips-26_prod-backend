// Real Express routes/authentication over loopback; isolated SQL/Vimeo adapters.
// No .env is loaded and no configured database/Vimeo account is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'course-api-isolated-test-key';
const S=require('../src/utils/authSecurity');
const fixtureUser=id=>({id,password:'SYNTHETIC_HASH',refresh_token:'sha256:'+'1'.repeat(64),two_factor_enabled:0,two_factor_secret:null,refresh_valid:1,idle_seconds:0});
let videos = [], uploadCalls = 0, providerMetadata;
const connection = {
    release() {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    query: async (sql, args = []) => {
        if (sql.startsWith('SELECT r.name FROM user_roles')) return [[{name:'Scholar'}]];
        if (sql.startsWith('SELECT ss.subject_id')) return [[{subject_id:5}]];
        if(sql.startsWith('INSERT IGNORE INTO course_workflows'))return [{}];
 if(sql.startsWith('SELECT * FROM course_workflows'))return [[{offering_id:1,state:'DRAFT',revision:0}]];
 if(sql.startsWith('SELECT COUNT(*) AS n FROM course_workflow_uploads'))return [[{n:0}]];
 if(/^(INSERT INTO|UPDATE|DELETE FROM) course_workflow/.test(sql))return [{affectedRows:1}];
 if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql.includes('AS refresh_valid')) return [[fixtureUser(Number(args[0]))]];
        if (sql.startsWith('UPDATE users')) return [{ affectedRows: 1 }];
        if (sql.startsWith('SELECT ss.')) return [Number(args[0]) === 7 && Number(args[1]) === 5 ? [{ id: 1, subject_id: 5, course_name: 'Isolated course', approved: 1 }] : []];
        if (sql.startsWith('SELECT * FROM videos WHERE scholar_user_id')) return [videos.filter(v => Number(v.scholar_user_id) === Number(args[0]) && Number(v.subject_id) === Number(args[1])).map(v => ({ ...v })).sort((a, b) => a.sequence_index - b.sequence_index)];
        if (sql.startsWith('SELECT * FROM videos WHERE id')) return [videos.filter(v => Number(v.id) === Number(args[0]) && (args.length === 1 || Number(v.scholar_user_id) === Number(args[1]))).map(v => ({ ...v }))];
        if (sql.startsWith('UPDATE videos SET title')) {
            const video = videos.find(v => v.id === args[2] && v.scholar_user_id === args[3] && !v.approved);
            if (video) Object.assign(video, { title: args[0], description: args[1] });
            return [{ affectedRows: video ? 1 : 0 }];
        }
        if (sql.startsWith('UPDATE videos SET sequence_index = -id')) { videos.forEach(v => { v.sequence_index = -v.id; }); return [{}]; }
        if (sql.startsWith('UPDATE videos SET sequence_index = ?')) { videos.find(v => v.id === args[1]).sequence_index = args[0]; return [{}]; }
        if (sql.startsWith('INSERT INTO videos')) {
            videos.push({ id: videos.length + 1, scholar_user_id: args[0], subject_id: args[1], title: args[2], description: args[3], video_url: args[4], sequence_index: args[5], approved: 0 });
            return [{ insertId: videos.length }];
        }
        throw new Error(`Unexpected isolated SQL: ${sql}`);
    }
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: { ...connection, getConnection: async () => connection } } };
const vimeoPath = require.resolve('../src/config/vimeo');
const providerAdapter = require('./fixtures/vimeoPolicy').syntheticVimeo();
require.cache[vimeoPath] = { id: vimeoPath, filename: vimeoPath, loaded: true, exports: { ...providerAdapter, upload(file, options, done) { uploadCalls++; providerMetadata = options; providerAdapter.uploaded('/videos/123456', options); done('/videos/123456'); } } };
const app = express(); app.use('/videos/my/:id', express.json({ limit: '256kb' })); app.use(express.json()); app.use('/videos', require('../src/routes/videoRoutes'));
let server, base;
test.before(async () => { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => new Promise(resolve => server.close(resolve)));
const token = (id = 7, roles = ['Scholar']) => jwt.sign({ id, roles, purpose:'access',session:S.credentialBinding(fixtureUser(id)) }, process.env.JWT_SECRET, { expiresIn: '1h' });
const request = (path, method = 'GET', body, auth = token()) => fetch(base + path, { method, headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
const lesson = id => ({ id, subject_id: 5, scholar_user_id: 7, title: `Lesson ${id}`, description: '', approved: 0, sequence_index: id });
test('real route authentication/roles and course ownership reject invalid, learner and other Scholar access', async () => {
    assert.equal((await request('/videos/scholar/courses/5', 'GET', null, 'invalid')).status, 403);
    assert.equal((await request('/videos/scholar/courses/5', 'GET', null, token(7, ['Learner']))).status, 403);
    assert.equal((await request('/videos/scholar/courses/5', 'GET', null, token(8))).status, 403);
    assert.equal((await request('/videos/scholar/courses/5')).status, 200);
});
test('order and metadata endpoints enforce ownership, exact permutation and published locks', async () => {
    videos = [lesson(1), lesson(2), lesson(3)];
    assert.equal((await request('/videos/scholar/courses/5/order', 'PUT', { videoIds: [1, 99, 2] })).status, 409);
    assert.equal((await request('/videos/scholar/courses/5/order', 'PUT', { videoIds: [1, 3, 2] })).status, 200);
    assert.deepEqual(videos.map(v => v.sequence_index), [1, 3, 2]);
    assert.equal((await request('/videos/my/1', 'PATCH', { title: 'Updated', description: '' }, token(8))).status, 404);
    assert.equal((await request('/videos/my/1', 'PATCH', { title: 'Updated', description: '' })).status, 200);
    videos[0].approved = 1;
    assert.equal((await request('/videos/my/1', 'PATCH', { title: 'Forbidden', description: '' })).status, 409);
    assert.equal((await request('/videos/scholar/courses/5/order', 'PUT', { videoIds: [3, 2, 1] })).status, 409);
});
test('real multipart upload route accepts video 12, ignores supplied sequence and rejects video 13 before Vimeo', async () => {
    videos = Array.from({ length: 11 }, (_, index) => lesson(index + 1));
    async function upload() {
        const body = new FormData(); body.append('subjectId', '5'); body.append('title', 'Twelfth lesson'); body.append('description', 'Isolated upload'); body.append('sequenceIndex', '999');
        body.append('video', new Blob([require('./fixtures/uploadFiles').mp4], { type: 'video/mp4' }), 'isolated.mp4');
        return fetch(base + '/videos', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body });
    }
    assert.equal((await upload()).status, 201);
    assert.equal(videos.at(-1).sequence_index, 12);
    assert.equal((await upload()).status, 409);
    assert.equal(videos.length, 12); assert.equal(uploadCalls, 1);
});
test('upload and PATCH accept identical full Unicode metadata and reject the same over-limit payloads', async () => {
    async function upload(title, description) {
        const body = new FormData(); body.append('subjectId', '5'); body.append('title', title); body.append('description', description);
        body.append('video', new Blob([require('./fixtures/uploadFiles').mp4], { type: 'video/mp4' }), 'metadata.mp4');
        return fetch(base + '/videos', { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body });
    }
    for (const [title, description] of [
        ['Normal title', 'Short text'], ['Near maximum '.padEnd(199, 'ä'), 'x'.repeat(9999)],
        ['🎓'.repeat(200), '🎓'.repeat(10000)], ['Unicode – Ọmọ ẹ̀kọ́', 'First paragraph\n\nSecond paragraph\n\nThird paragraph']
    ]) {
        videos = [lesson(1)];
        assert.equal((await upload(title, description)).status, 201);
        assert.equal(videos.at(-1).title, title); assert.equal(videos.at(-1).description, description);
        assert.ok(providerMetadata.name.length <= 128);
        assert.equal(providerMetadata.description, 'Lesson details are managed in UniClips.');
        assert.equal((await request('/videos/my/1', 'PATCH', { title, description })).status, 200);
        assert.equal(videos[0].title, title); assert.equal(videos[0].description, description);
    }
    for (const [title, description] of [['🎓'.repeat(201), ''], ['Lesson', '🎓'.repeat(10001)]]) {
        videos = [lesson(1)]; const calls = uploadCalls;
        const posted = await upload(title, description);
        const edited = await request('/videos/my/1', 'PATCH', { title, description });
        assert.equal(posted.status, 400); assert.equal(edited.status, 400);
        assert.deepEqual(await posted.json(), await edited.json());
        assert.equal(uploadCalls, calls);
    }
    const escaped = JSON.stringify({ title: 'Unicode', description: '🎓'.repeat(10000) }).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    assert.ok(escaped.length > 100 * 1024);
    assert.equal((await fetch(base + '/videos/my/1', { method: 'PATCH', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: escaped })).status, 200);
});
