// API product fields only. Adding a database column never exposes it implicitly.
const USER_FIELDS = Object.freeze([
  'id', 'fname', 'lname', 'name', 'email', 'isScholar', 'is_scholar',
  'created_at', 'updated_at', 'bio', 'favorite_subject', 'favorite_food',
  'hobbies', 'profile_image_url', 'avatar_id', 'university_id', 'degree_programme'
]);
const SCHOLAR_FIELDS = Object.freeze([
  'id', 'user_id', 'university', 'degree', 'year', 'approved', 'task_card_url',
  'created_at', 'updated_at', 'university_id', 'country_id', 'country_name',
  'country_code', 'stripe_account_id', 'stripe_onboarding_complete',
  'stripe_charges_enabled', 'stripe_payouts_enabled', 'stripe_details_submitted'
]);

function productFields(row, fields) {
  const result = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const value = row[field];
    // These database fields are scalars/dates, never arbitrary nested objects.
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)
      || value instanceof Date) result[field] = value;
  }
  return result;
}

function scholarProfileResponse(row) {
  return row == null ? null : productFields(row, SCHOLAR_FIELDS);
}

function userResponse(row, { roles, scholarProfile } = {}) {
  const result = productFields(row, USER_FIELDS);
  if (roles !== undefined) result.roles = roles.filter(role => typeof role === 'string');
  if (scholarProfile !== undefined) result.scholarProfile = scholarProfileResponse(scholarProfile);
  return result;
}

module.exports = { userResponse, scholarProfileResponse };
