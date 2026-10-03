const stripe = require('../config/stripe');
const { pool } = require('../config/db');
const { classifyAccountError } = require('../services/payments/stripeProvider');

// Helper to check if Stripe and required env vars are configured
const checkStripeConfiguration = () => {
    const errors = [];
    
    if (!process.env.STRIPE_SECRET_KEY || 
        process.env.STRIPE_SECRET_KEY.includes('dummy') ||
        !process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
        errors.push('STRIPE_SECRET_KEY is not configured properly');
    }
    
    if (!process.env.FRONTEND_URL) {
        errors.push('FRONTEND_URL is not configured');
    }
    
    return errors;
};

/**
 * Create Stripe Connect Account and Onboarding Link for Scholar
 */
const createConnectAccount = async (req, res) => {
    try {
        // Check if Stripe is properly configured
        const configErrors = checkStripeConfiguration();
        if (configErrors.length > 0) {
            console.error('Stripe configuration errors:', configErrors);
            return res.status(503).json({ 
                message: 'Stripe is not configured properly. Missing: ' + configErrors.join(', ')
            });
        }

        const scholarUserId = req.user.id;

        // Check if scholar profile exists and is approved
        const [scholarProfile] = await pool.query(
            'SELECT * FROM scholar_profile WHERE user_id = ? AND approved = 1',
            [scholarUserId]
        );

        if (scholarProfile.length === 0) {
            return res.status(403).json({ 
                message: 'Scholar profile not found or not approved' 
            });
        }

        const scholar = scholarProfile[0];

        // Check if already has Stripe account
        if (scholar.stripe_account_id) {
            try {
                // Verify the account exists on current Stripe platform
                await stripe.accounts.retrieve(scholar.stripe_account_id);
                
                // Account exists, create new onboarding link
                const accountLink = await stripe.accountLinks.create({
                    account: scholar.stripe_account_id,
                    refresh_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=refresh`,
                    return_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=success`,
                    type: 'account_onboarding',
                });

                return res.json({ 
                    url: accountLink.url,
                    accountId: scholar.stripe_account_id 
                });
            } catch (stripeError) {
                return res.status(503).json({ message: 'Unable to verify your existing Stripe account. Its linkage has been preserved.',
                    code: classifyAccountError(stripeError) });
            }
        }

        const academic = await require('../utils/academicContext').scholarContext(pool, scholarUserId);
        if (academic?.country_code !== 'FI') {
            return res.status(409).json({ message: 'Payout onboarding for your country is not enabled yet. Please contact UniClips.' });
        }

        // Get user details
        const [users] = await pool.query(
            'SELECT fname, lname, email FROM users WHERE id = ?',
            [scholarUserId]
        );

        const user = users[0];

        // Create new Stripe Connect Express account
        const account = await stripe.accounts.create({
            type: 'express',
            country: 'FI', // Finland - can be made dynamic based on scholar's country
            email: user.email,
            capabilities: {
                transfers: { requested: true },
            },
            business_type: 'individual',
            individual: {
                email: user.email,
                first_name: user.fname,
                last_name: user.lname,
            },
        });

        // Save Stripe account ID to database
        await pool.query(
            'UPDATE scholar_profile SET stripe_account_id = ? WHERE user_id = ?',
            [account.id, scholarUserId]
        );

        // Create account onboarding link
        const accountLink = await stripe.accountLinks.create({
            account: account.id,
            refresh_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=refresh`,
            return_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=success`,
            type: 'account_onboarding',
        });

        res.json({ 
            url: accountLink.url,
            accountId: account.id 
        });

    } catch (error) {
        console.error('Error creating Stripe Connect account:', error);
        res.status(500).json({ 
            message: 'Error creating Stripe account', 
            error: error.message 
        });
    }
};

/**
 * Get Stripe Account Status for Scholar
 */
const getAccountStatus = async (req, res) => {
    try {
        const scholarUserId = req.user.id;

        // Use a simpler query that only requires stripe_account_id column
        // Other columns might not exist in all database versions
        let scholarProfile;
        try {
            [scholarProfile] = await pool.query(
                'SELECT stripe_account_id, stripe_onboarding_complete, stripe_details_submitted FROM scholar_profile WHERE user_id = ?',
                [scholarUserId]
            );
        } catch (dbError) {
            // If the query fails (missing columns), try simpler query
            console.warn('Extended stripe columns not found, using basic query:', dbError.message);
            [scholarProfile] = await pool.query(
                'SELECT stripe_account_id FROM scholar_profile WHERE user_id = ?',
                [scholarUserId]
            );
        }

        if (scholarProfile.length === 0) {
            return res.status(404).json({ message: 'Scholar profile not found' });
        }

        const scholar = scholarProfile[0];

        if (!scholar.stripe_account_id) {
            return res.json({ 
                connected: false,
                onboardingComplete: false,
                detailsSubmitted: false,
                chargesEnabled: false,
                payoutsEnabled: false
            });
        }

        // Check if Stripe is properly configured
        const configErrors = checkStripeConfiguration();
        if (configErrors.length > 0) {
            // Return database values if Stripe not configured
            return res.json({
                connected: true,
                accountId: scholar.stripe_account_id,
                onboardingComplete: scholar.stripe_onboarding_complete || false,
                detailsSubmitted: scholar.stripe_details_submitted || false,
                chargesEnabled: false,
                payoutsEnabled: false,
                country: 'FI',
                currency: 'eur',
                stripeNotConfigured: true,
                configErrors: configErrors
            });
        }

        // Get account details from Stripe
        let account;
        try {
            account = await stripe.accounts.retrieve(scholar.stripe_account_id);
        } catch (stripeError) {
            return res.status(503).json({ connected: true, statusUnavailable: true,
                code: classifyAccountError(stripeError), message: 'Stripe account status is unavailable. Your linked account has been preserved.' });
        }

        // Update database with current status (try/catch for missing columns)
        try {
            await pool.query(
                'UPDATE scholar_profile SET stripe_onboarding_complete = ?, stripe_details_submitted = ? WHERE user_id = ?',
                [
                    // Only mark as complete if BOTH details_submitted AND charges_enabled are true
                    (account.details_submitted && account.charges_enabled) ? 1 : 0,
                    account.details_submitted ? 1 : 0,
                    scholarUserId
                ]
            );
        } catch (updateError) {
            console.warn('Could not update stripe status columns:', updateError.message);
        }

        // Only consider "linked" if onboarding is complete (details_submitted AND charges_enabled)
        const isFullyOnboarded = account.details_submitted && account.charges_enabled;

        res.json({
            connected: !!account.id, // Has a Stripe account ID
            accountId: account.id,
            onboardingComplete: isFullyOnboarded, // Based only on onboarding status
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            country: account.country,
            currency: account.default_currency
        });

    } catch (error) {
        console.error('Error getting Stripe account status:', error);
        res.status(500).json({ 
            message: 'Error retrieving account status', 
            error: error.message 
        });
    }
};

/**
 * Create Dashboard Link for Scholar to manage Stripe account
 */
const createDashboardLink = async (req, res) => {
    try {
        const scholarUserId = req.user.id;

        const [scholarProfile] = await pool.query(
            'SELECT stripe_account_id FROM scholar_profile WHERE user_id = ?',
            [scholarUserId]
        );

        if (scholarProfile.length === 0 || !scholarProfile[0].stripe_account_id) {
            return res.status(404).json({ 
                message: 'Stripe account not found' 
            });
        }

        const loginLink = await stripe.accounts.createLoginLink(
            scholarProfile[0].stripe_account_id
        );

        res.json({ url: loginLink.url });

    } catch (error) {
        console.error('Error creating dashboard link:', error);
        res.status(500).json({ 
            message: 'Error creating dashboard link', 
            error: error.message 
        });
    }
};

/**
 * Get Platform Balance (Admin only)
 */
const getPlatformBalance = async (req, res) => {
    try {
        const balance = await stripe.balance.retrieve();
        
        // Format balance by currency
        const available = {};
        const pending = {};
        
        balance.available.forEach(b => {
            available[b.currency] = b.amount / 100;
        });
        
        balance.pending.forEach(b => {
            pending[b.currency] = b.amount / 100;
        });

        res.json({
            available,
            pending,
            message: 'Pending funds become available 2-7 days after payment'
        });

    } catch (error) {
        console.error('Error getting platform balance:', error);
        res.status(500).json({ 
            message: 'Error getting platform balance', 
            error: error.message 
        });
    }
};

/**
 * Create Payout to Scholar (Admin only)
 */
const createPayout = async (req, res) => {
    try {
        const { paymentMode } = require('../services/paymentRelease/mode');
        if (paymentMode() !== 'phase2a') return res.status(409).json({ message: 'Manual transfer execution is unavailable in the current payment release. Recorded earnings and transfer history remain available.' });
        const { transferOrder } = require('../services/payments');
        let orderIds;
        if (req.body.orderId) orderIds = [req.body.orderId];
        else {
            // Compatibility with the existing Admin release control: the supplied
            // amount is only a consistency check, never an instruction to Stripe.
            const { toMinor } = require('../services/payments/money');
            const currency = String(req.body.currency || 'EUR').toUpperCase();
            if (currency !== 'EUR' || !req.body.scholarUserId) return res.status(409).json({ message: 'No supported authoritative allocation selected.' });
            const [rows] = await pool.query(`SELECT t.order_id,t.amount_minor FROM payment_transfers t
                JOIN payment_orders o ON o.id=t.order_id WHERE o.scholar_id=? AND t.currency=?
                AND t.state IN ('pending','uncertain','failed') AND o.refund_state='none' AND o.dispute_state='none'`,
                [req.body.scholarUserId,currency]);
            const expected = rows.reduce((sum,row) => sum + Number(row.amount_minor),0);
            let requested;
            try { requested = toMinor(req.body.amount,currency); } catch { return res.status(400).json({ message: 'Invalid transfer amount.' }); }
            if (!rows.length || expected !== requested) return res.status(409).json({ message: 'Release must match recorded new allocations. Legacy earnings require reconciliation before release.' });
            orderIds = rows.map(row=>row.order_id);
        }
        const results = [];
        for (const id of orderIds) results.push({ orderId:id,...await transferOrder(id) });
        const completed = results.every(result=>result.state==='completed');
        res.status(completed ? 200 : 409).json({ success:completed,results,
            message:completed ? 'Recorded allocations transferred to Stripe. Bank payout is managed separately.' : 'Some allocations remain pending or require reconciliation. Refresh before retrying.' });
    } catch (error) {
        res.status(error.status || 503).json({ message: error.status ? error.message : 'Transfer requires reconciliation. No blind retry was made.' });
    }
};

/**
 * Get all scholars with their Stripe status (Admin only)
 */
const getAllScholarsStripeStatus = async (req, res) => {
    try {
        // Try with all columns first, fall back to basic columns if they don't exist
        let scholars;
        try {
            [scholars] = await pool.query(`
                SELECT 
                    u.id,
                    u.fname,
                    u.lname,
                    u.email,
                    sp.stripe_account_id,
                    sp.stripe_onboarding_complete,
                    sp.stripe_details_submitted,
                    sp.approved
                FROM users u
                JOIN scholar_profile sp ON u.id = sp.user_id
                WHERE sp.approved = 1
                ORDER BY u.fname, u.lname
            `);
        } catch (dbError) {
            console.warn('Extended stripe columns not found, using basic query:', dbError.message);
            [scholars] = await pool.query(`
                SELECT 
                    u.id,
                    u.fname,
                    u.lname,
                    u.email,
                    sp.stripe_account_id,
                    sp.approved
                FROM users u
                JOIN scholar_profile sp ON u.id = sp.user_id
                WHERE sp.approved = 1
                ORDER BY u.fname, u.lname
            `);
        }

        // Country code to name mapping
        const countryNames = {
            'FI': 'Finland',
            'US': 'United States',
            'GB': 'United Kingdom',
            'DE': 'Germany',
            'SE': 'Sweden',
            'NO': 'Norway',
            'DK': 'Denmark',
            'EE': 'Estonia'
        };

        // Check if Stripe is properly configured
        const stripeConfigured = process.env.STRIPE_SECRET_KEY && 
                                 !process.env.STRIPE_SECRET_KEY.includes('dummy') &&
                                 process.env.STRIPE_SECRET_KEY.startsWith('sk_');

        // Enrich with live Stripe data only if Stripe is configured
        const scholarsWithStripeStatus = await Promise.all(
            scholars.map(async (scholar) => {
                const earnings = await require('../services/payments/earningsService').scholarEarnings(pool, scholar.id);
                const pendingBalance = Number(earnings.summary.pendingBalance);
                scholar.earningsByCurrency = earnings.summariesByCurrency;
                scholar.currency = 'EUR';
                scholar.legacyReconciliationRequired = earnings.summary.legacyReconciliationRequired;

                if (!scholar.stripe_account_id) {
                    return {
                        ...scholar,
                        stripeStatus: 'Action Required',
                        payoutsEnabled: false,
                        country: 'Finland',
                        pendingBalance: pendingBalance.toFixed(2)
                    };
                }

                // If Stripe not configured, use database values
                if (!stripeConfigured) {
                    return {
                        ...scholar,
                        stripeStatus: scholar.stripe_onboarding_complete ? 'Linked' : 'Incomplete',
                        payoutsEnabled: scholar.stripe_onboarding_complete || false,
                        country: 'Finland',
                        pendingBalance: pendingBalance.toFixed(2)
                    };
                }

                try {
                    const account = await stripe.accounts.retrieve(scholar.stripe_account_id);
                    return {
                        ...scholar,
                        stripeStatus: account.details_submitted ? 'Linked' : 'Incomplete',
                        payoutsEnabled: account.payouts_enabled,
                        country: countryNames[account.country] || account.country,
                        pendingBalance: pendingBalance.toFixed(2)
                    };
                } catch (error) {
                    console.error(`Error retrieving Stripe account for scholar ${scholar.id}:`, error.message);
                    return {
                        ...scholar,
                        stripeStatus: 'Error',
                        payoutsEnabled: false,
                        country: 'Finland',
                        pendingBalance: pendingBalance.toFixed(2)
                    };
                }
            })
        );

        res.json({ scholars: scholarsWithStripeStatus });

    } catch (error) {
        console.error('Error getting scholars Stripe status:', error);
        res.status(500).json({ 
            message: 'Error retrieving scholars status', 
            error: error.message 
        });
    }
};

/**
 * Get Scholar's Earnings and Sales Statistics
 */
const getScholarEarnings = async (req, res) => {
    try { res.json(await require('../services/payments/earningsService').scholarEarnings(pool, req.user.id)); }
    catch { res.status(503).json({ message: 'Unable to retrieve currency-separated earnings.' }); }
};

/**
 * Send Stripe verification email to scholar with link to complete requirements
 */
const sendVerificationEmail = async (req, res) => {
    try {
        const { sendStripeVerificationEmail } = require('../utils/emailService');
        const scholarUserId = req.user.id;

        // Get scholar profile with Stripe account
        const [scholarProfile] = await pool.query(
            'SELECT sp.stripe_account_id, u.email, u.fname, u.lname FROM scholar_profile sp JOIN users u ON sp.user_id = u.id WHERE sp.user_id = ?',
            [scholarUserId]
        );

        if (scholarProfile.length === 0 || !scholarProfile[0].stripe_account_id) {
            return res.status(404).json({ 
                message: 'Stripe account not found. Please connect your Stripe account first.' 
            });
        }

        const scholar = scholarProfile[0];

        // Get account details from Stripe to check requirements
        const account = await stripe.accounts.retrieve(scholar.stripe_account_id);

        // Check if there are pending requirements
        const pendingRequirements = account.requirements?.currently_due || [];
        const eventuallyDue = account.requirements?.eventually_due || [];
        const allRequirements = [...new Set([...pendingRequirements, ...eventuallyDue])];

        if (allRequirements.length === 0 && account.charges_enabled && account.payouts_enabled) {
            return res.json({ 
                message: 'Your Stripe account is fully verified! No additional action needed.',
                fullyVerified: true
            });
        }

        // Create an account link for the scholar to complete verification
        // Always use 'account_onboarding' as Stripe requires it for Express accounts
        const accountLink = await stripe.accountLinks.create({
            account: scholar.stripe_account_id,
            refresh_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=refresh`,
            return_url: `${process.env.FRONTEND_URL}/scholar-dashboard?stripe=success`,
            type: 'account_onboarding',
        });

        // Send email with verification link
        const userName = scholar.fname || 'Scholar';
        const emailResult = await sendStripeVerificationEmail(
            scholar.email,
            accountLink.url,
            userName,
            allRequirements
        );

        if (!emailResult.success) {
            console.error('Failed to send Stripe verification email:', emailResult.error);
            return res.status(500).json({ 
                message: 'Failed to send verification email. Please try again.',
                error: emailResult.error
            });
        }

        res.json({ 
            message: `Verification email sent to ${scholar.email}`,
            requirements: allRequirements,
            emailSent: true
        });

    } catch (error) {
        console.error('Error sending Stripe verification email:', error);
        res.status(500).json({ 
            message: 'Error sending verification email', 
            error: error.message 
        });
    }
};

/**
 * Get Stripe account requirements/pending actions
 */
const getAccountRequirements = async (req, res) => {
    try {
        const scholarUserId = req.user.id;

        const [scholarProfile] = await pool.query(
            'SELECT stripe_account_id FROM scholar_profile WHERE user_id = ?',
            [scholarUserId]
        );

        if (scholarProfile.length === 0 || !scholarProfile[0].stripe_account_id) {
            return res.json({ 
                connected: false,
                requirements: []
            });
        }

        const account = await stripe.accounts.retrieve(scholarProfile[0].stripe_account_id);

        const pendingRequirements = account.requirements?.currently_due || [];
        const eventuallyDue = account.requirements?.eventually_due || [];
        const pastDue = account.requirements?.past_due || [];

        res.json({
            connected: true,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            requirements: {
                currentlyDue: pendingRequirements,
                eventuallyDue: eventuallyDue,
                pastDue: pastDue,
                hasRequirements: pendingRequirements.length > 0 || eventuallyDue.length > 0 || pastDue.length > 0
            }
        });

    } catch (error) {
        console.error('Error getting Stripe requirements:', error);
        res.status(500).json({ 
            message: 'Error retrieving account requirements', 
            error: error.message 
        });
    }
};

module.exports = {
    createConnectAccount,
    getAccountStatus,
    createDashboardLink,
    createPayout,
    getAllScholarsStripeStatus,
    getScholarEarnings,
    getPlatformBalance,
    sendVerificationEmail,
    getAccountRequirements
};
