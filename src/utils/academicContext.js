const universityLabel = university => university.short_name
    ? `${university.name} (${university.short_name})` : university.name;

async function resolveUniversity(db, name) {
    const [rows] = await db.query(`SELECT u.*, c.name AS country_name, c.code AS country_code
        FROM universities u JOIN countries c ON c.id = u.country_id
        WHERE u.name = ? OR CONCAT(u.name, ' (', u.short_name, ')') = ?`, [name, name]);
    return rows.length === 1 ? rows[0] : null;
}

async function scholarContext(db, userId) {
    const [profiles] = await db.query('SELECT * FROM scholar_profile WHERE user_id = ?', [userId]);
    const profile = profiles[0];
    if (!profile) return null;
    const university = await resolveUniversity(db, profile.university);
    return { ...profile, university_id: university?.id ?? null,
        country_id: university?.country_id ?? null, country_name: university?.country_name ?? null,
        country_code: university?.country_code ?? null };
}

async function availableSubjects(db, profile) {
    if (!profile?.approved || !profile.university_id) return [];
    const [rows] = await db.query(`SELECT id, name, degree_programmes, university_id FROM subjects
        WHERE university_id = ? AND degree_programmes = ? ORDER BY name`,
    [profile.university_id, profile.degree]);
    return rows;
}

module.exports = { universityLabel, resolveUniversity, scholarContext, availableSubjects };
