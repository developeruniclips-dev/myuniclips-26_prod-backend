const hamkLanguages = require('../config/hamkProgrammeLanguages.json');
const { universityLabel } = require('./academicContext');

const GENERAL_COURSE_THRESHOLD = 4;
const normalizeCourseName = value => String(value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
const groupKey = subject => JSON.stringify([Number(subject.university_id), normalizeCourseName(subject.name)]);

function programmeLanguage(subject) {
    if (subject.university_short_name === 'HAMK' && subject.university_name === 'Häme University of Applied Sciences') {
        return hamkLanguages[subject.degree_programmes] || null;
    }
    if (subject.university_short_name === 'FUNAAB') return 'en';
    return null;
}

// Academic grouping only. Never use a group key as an offering/purchase identity.
function buildGeneralCourseIndex(subjects) {
    const groups = new Map();
    for (const subject of subjects) {
        if (!subject.university_id || !normalizeCourseName(subject.name) || !subject.degree_programmes?.trim()) continue;
        const key = groupKey(subject);
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(subject.degree_programmes);
    }
    const index = new Map();
    for (const subject of subjects) {
        const programmes = groups.get(groupKey(subject)) || new Set();
        const general = programmes.size >= GENERAL_COURSE_THRESHOLD;
        const language = programmeLanguage(subject);
        index.set(Number(subject.id), {
            university_id: subject.university_id,
            university_label: subject.university_name ? universityLabel({ name: subject.university_name, short_name: subject.university_short_name }) : null,
            degree_programme: subject.degree_programmes,
            is_general_university_course: general,
            distinct_programme_count: programmes.size,
            programme_language: language,
            course_category_label: general ? (language === 'fi' ? 'Yleinen korkeakoulukurssi' : 'General University Course') : subject.degree_programmes,
            applicable_programmes: general ? [...programmes].sort() : [subject.degree_programmes].filter(Boolean)
        });
    }
    return index;
}

async function annotateCourses(db, offerings) {
    const ids = [...new Set(offerings.map(row => Number(row.subject_id)).filter(id => Number.isInteger(id) && id > 0))];
    if (!ids.length) return offerings;
    // One batch for the universities represented in this response, not one query per card/video.
    const [subjects] = await db.query(`SELECT s.id, s.name, s.degree_programmes, s.university_id,
        u.name AS university_name, u.short_name AS university_short_name
        FROM subjects s JOIN universities u ON u.id = s.university_id
        WHERE s.university_id IN (SELECT university_id FROM subjects WHERE id IN (?))`, [ids]);
    const index = buildGeneralCourseIndex(subjects);
    return offerings.map(row => ({ ...row, ...index.get(Number(row.subject_id)) }));
}

function catalogueSummary(subjects) {
    const index = buildGeneralCourseIndex(subjects);
    return [...new Set(subjects.map(s => Number(s.university_id)))].sort((a, b) => a - b).map(universityId => {
        const rows = subjects.filter(s => Number(s.university_id) === universityId);
        return { universityId, entries: rows.length, programmes: new Set(rows.map(s => s.degree_programmes)).size,
            generalNames: new Set(rows.filter(s => index.get(Number(s.id)).is_general_university_course).map(groupKey)).size };
    });
}

module.exports = { GENERAL_COURSE_THRESHOLD, normalizeCourseName, programmeLanguage, buildGeneralCourseIndex, annotateCourses, catalogueSummary };
