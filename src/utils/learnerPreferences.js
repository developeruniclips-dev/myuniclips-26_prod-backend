// Validate study preferences against the existing location/subject catalogue.
async function learnerPreferences(body, pool) {
  const fields = {};
  const invalid = (message) => { const error = new Error(message); error.statusCode = 400; throw error; };
  if (body.avatarId !== undefined) {
    if (!/^avatar_(0[1-9]|10)$/.test(body.avatarId)) invalid('Choose a valid avatar.');
    fields.avatar_id = body.avatarId;
  }
  if (body.universityId !== undefined || body.degreeProgramme !== undefined) {
    const universityId = body.universityId === '' || body.universityId === null ? null : Number(body.universityId);
    const programme = body.degreeProgramme || '';
    if (typeof programme !== 'string' || programme.length > 255) invalid('Choose a valid degree programme.');
    if (universityId !== null) {
      if (!Number.isSafeInteger(universityId) || universityId <= 0) invalid('Choose a valid university.');
      const [universities] = await pool.query('SELECT id FROM universities WHERE id = ?', [universityId]);
      if (!universities.length) invalid('Choose a university from the list.');
      if (programme) {
        const [subjects] = await pool.query(
          'SELECT id FROM subjects WHERE university_id = ? AND degree_programmes = ? LIMIT 1',
          [universityId, programme]
        );
        if (!subjects.length) invalid('Choose a programme offered at your university.');
      }
    } else if (programme) invalid('Choose a university first.');
    fields.university_id = universityId;
    fields.degree_programme = programme || null;
  }
  return fields;
}

module.exports = { learnerPreferences };
