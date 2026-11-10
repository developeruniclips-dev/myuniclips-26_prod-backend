const {readBounded}=require('../utils/readCapacity');
const { pool } = require('../config/db');

const SubjectModel = {
    findAll: () => readBounded(pool,"SELECT * FROM subjects"),

    findById: (id) => pool.query("SELECT * FROM subjects WHERE id = ?", [id]),

    // The public creation route remains disabled. Future onboarding must supply
    // an authoritative university and an explicit FI price, never a name guess.
    create: async (input) => {
        const invalid=()=>Object.assign(new Error('Approved academic context required'),{status:400});
        if(!input||typeof input!=='object'||typeof input.name!=='string'||!input.name.trim()||typeof input.degreeProgramme!=='string'||!input.degreeProgramme.trim()||!Number.isSafeInteger(input.universityId)||input.universityId<1)throw invalid();
        const [[university]]=await pool.query('SELECT u.id,c.code FROM universities u JOIN countries c ON c.id=u.country_id WHERE u.id=?',[input.universityId]);
        if(!university||!['FI','NG'].includes(university.code))throw invalid();
        let price=null;
        if(university.code==='FI'){const {toMinor,decimal}=require('../services/payments/money');let minor;try{minor=toMinor(input.approvedEurPrice,'EUR');}catch{throw invalid();}if(minor<50)throw invalid();price=decimal(minor);}
        return pool.query('INSERT INTO subjects (name,university_id,degree_programmes,bundle_price) VALUES (?,?,?,?)',[input.name.trim(),input.universityId,input.degreeProgramme.trim(),price]);
    },

    update: (id, name) => {
        return pool.query("UPDATE subjects SET name = ? WHERE id = ?", [name, id]);
    },

    delete: (id) => {
        return pool.query("DELETE FROM subjects WHERE id = ?", [id]);
    },

    // Update bundle price for a subject with timestamp (admin only)
    updateBundlePrice: (subjectId, bundlePrice) => {
        return pool.query(
            "UPDATE subjects SET bundle_price = ?, bundle_price_updated_at = NOW() WHERE id = ?", 
            [bundlePrice, subjectId]
        );
    },

    // Get subject with bundle price
    findByIdWithPrice: (id) => pool.query(
        "SELECT id, name, degree_programmes, bundle_price, bundle_price_updated_at FROM subjects WHERE id = ?", 
        [id]
    )
};

module.exports = { SubjectModel };
