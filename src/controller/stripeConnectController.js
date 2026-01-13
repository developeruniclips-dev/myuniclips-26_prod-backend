const stripe = require('../config/stripe');
const { pool } = require('../config/db');

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
                // Account doesn't exist on this platform (likely created with different keys)
                // Clear the old account ID and create a new one
                console.warn(`Stripe account ${scholar.stripe_account_id} not found on platform, creating new account`);
                await pool.query(
                    'UPDATE scholar_profile SET stripe_account_id = NULL, stripe_onboarding_complete = 0, stripe_details_submitted = 0 WHERE user_id = ?',
                    [scholarUserId]
                );
                // Continue to create new account below
            }
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
            // Account doesn't exist on this platform - clear it and return not connected
            console.warn(`Stripe account ${scholar.stripe_account_id} not found, clearing from database`);
            await pool.query(
                'UPDATE scholar_profile SET stripe_account_id = NULL, stripe_onboarding_complete = 0, stripe_details_submitted = 0 WHERE user_id = ?',
                [scholarUserId]
            );
            return res.json({ 
                connected: false,
                onboardingComplete: false,
                detailsSubmitted: false,
                chargesEnabled: false,
                payoutsEnabled: false,
                accountCleared: true,
                message: 'Previous Stripe account was invalid and has been cleared. Please reconnect.'
            });
        }

        // Update database with current status (try/catch for missing columns)
        try {
            await pool.query(
                'UPDATE scholar_profile SET stripe_onboarding_complete = ?, stripe_details_submitted = ? WHERE user_id = ?',
                [
                    account.details_submitted ? 1 : 0,
                    account.details_submitted ? 1 : 0,
                    scholarUserId
                ]
            );
        } catch (updateError) {
            console.warn('Could not update stripe status columns:', updateError.message);
        }

        res.json({
            connected: true,
            accountId: account.id,
            onboardingComplete: account.details_submitted,
            detailsSubmitted: account.details_submitted,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            country: account.country,
            currency: account.default_currency,
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
 * Create Payout to Scholar (Admin only)
 */
const createPayout = async (req, res) => {
    try {
        const { scholarUserId, amount, currency = 'eur', description } = req.body;

        // Get scholar's Stripe account (handle missing columns gracefully)
        let scholarProfile;
        try {
            [scholarProfile] = await pool.query(
                'SELECT stripe_account_id, stripe_onboarding_complete FROM scholar_profile WHERE user_id = ?',
                [scholarUserId]
            );
        } catch (dbError) {
            console.warn('Extended stripe columns not found, using basic query:', dbError.message);
            [scholarProfile] = await pool.query(
                'SELECT stripe_account_id FROM scholar_profile WHERE user_id = ?',
                [scholarUserId]
            );
        }

        if (scholarProfile.length === 0) {
            return res.status(404).json({ message: 'Scholar not found' });
        }

        if (!scholarProfile[0].stripe_account_id) {
            return res.status(400).json({ 
                message: 'Scholar has not completed Stripe onboarding' 
            });
        }

        // Create transfer to connected account
        const transfer = await stripe.transfers.create({
            amount: Math.round(amount * 100), // Convert to cents
            currency: currency,
            destination: scholarProfile[0].stripe_account_id,
            description: description || 'Payout from UniClips',
        });

        // Log the payout in database (optional - you can create a payouts table)
        await pool.query(
            'INSERT INTO scholar_payouts (scholar_user_id, stripe_transfer_id, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
            [scholarUserId, transfer.id, amount, currency, 'completed']
        );

        res.json({ 
            success: true,
            transfer: {
                id: transfer.id,
                amount: transfer.amount / 100,
                currency: transfer.currency,
                destination: transfer.destination
            }
        });

    } catch (error) {
        console.error('Error creating payout:', error);
        res.status(500).json({ 
            message: 'Error creating payout', 
            error: error.message 
        });
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

        // Check if Stripe is properly configured
        const stripeConfigured = process.env.STRIPE_SECRET_KEY && 
                                 !process.env.STRIPE_SECRET_KEY.includes('dummy') &&
                                 process.env.STRIPE_SECRET_KEY.startsWith('sk_');

        // Enrich with live Stripe data only if Stripe is configured
        const scholarsWithStripeStatus = await Promise.all(
            scholars.map(async (scholar) => {
                if (!scholar.stripe_account_id) {
                    return {
                        ...scholar,
                        stripeStatus: 'Action Required',
                        payoutsEnabled: false
                    };
                }

                // If Stripe not configured, use database values
                if (!stripeConfigured) {
                    return {
                        ...scholar,
                        stripeStatus: scholar.stripe_onboarding_complete ? 'Linked' : 'Incomplete',
                        payoutsEnabled: scholar.stripe_onboarding_complete || false,
                        country: 'Finland'
                    };
                }

                try {
                    const account = await stripe.accounts.retrieve(scholar.stripe_account_id);
                    return {
                        ...scholar,
                        stripeStatus: account.details_submitted ? 'Linked' : 'Incomplete',
                        payoutsEnabled: account.payouts_enabled,
                        country: account.country
                    };
                } catch (error) {
                    console.error(`Error retrieving Stripe account for scholar ${scholar.id}:`, error.message);
                    return {
                        ...scholar,
                        stripeStatus: 'Error',
                        payoutsEnabled: false
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
    try {
        const scholarUserId = req.user.id;

        // Get total sales from purchases table (no status column exists)
        const [salesData] = await pool.query(`
            SELECT 
                COUNT(p.id) as total_sales,
                COALESCE(SUM(v.price), 0) as total_revenue
            FROM purchases p
            JOIN videos v ON p.video_id = v.id
            WHERE v.scholar_user_id = ?
        `, [scholarUserId]);

        // Get sales by video
        const [salesByVideo] = await pool.query(`
            SELECT 
                v.id,
                v.title,
                v.price,
                s.name as subject_name,
                COUNT(p.id) as sales_count,
                COALESCE(SUM(v.price), 0) as video_revenue
            FROM videos v
            LEFT JOIN purchases p ON v.id = p.video_id
            LEFT JOIN subjects s ON v.subject_id = s.id
            WHERE v.scholar_user_id = ? AND v.approved = 1
            GROUP BY v.id, v.title, v.price, s.name
            ORDER BY sales_count DESC
        `, [scholarUserId]);

        // Get payouts received
        const [payoutsData] = await pool.query(`
            SELECT 
                COALESCE(SUM(amount), 0) as total_paid,
                COUNT(*) as payout_count
            FROM scholar_payouts 
            WHERE scholar_user_id = ? AND status = 'completed'
        `, [scholarUserId]);

        // Get payout history for display
        const [payoutHistory] = await pool.query(`
            SELECT id, amount, currency, status, stripe_transfer_id, created_at
            FROM scholar_payouts 
            WHERE scholar_user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `, [scholarUserId]);

        // Calculate earnings with 70%/50% fee structure
        // First 100 sales per course: scholar gets 70%
        // After 100 sales: scholar gets 50%
        const totalRevenue = parseFloat(salesData[0]?.total_revenue) || 0;
        const totalSalesCount = parseInt(salesData[0]?.total_sales) || 0;
        const totalPaid = parseFloat(payoutsData[0]?.total_paid) || 0;
        
        // Simplified calculation: assume average across all sales
        // First 100 at 70%, rest at 50%
        let scholarEarnings = 0;
        let platformFee = 0;
        
        if (totalSalesCount <= 100) {
            scholarEarnings = totalRevenue * 0.70;
            platformFee = totalRevenue * 0.30;
        } else {
            // Split calculation
            const revenueBelow100 = (100 / totalSalesCount) * totalRevenue;
            const revenueAbove100 = totalRevenue - revenueBelow100;
            scholarEarnings = (revenueBelow100 * 0.70) + (revenueAbove100 * 0.50);
            platformFee = (revenueBelow100 * 0.30) + (revenueAbove100 * 0.50);
        }
        
        const pendingBalance = scholarEarnings - totalPaid;

        res.json({
            summary: {
                totalSales: totalSalesCount,
                totalRevenue: totalRevenue.toFixed(2),
                platformFee: platformFee.toFixed(2),
                scholarEarnings: scholarEarnings.toFixed(2),
                totalPaid: totalPaid.toFixed(2),
                pendingBalance: pendingBalance.toFixed(2),
                payoutCount: parseInt(payoutsData[0]?.payout_count) || 0
            },
            salesByVideo: salesByVideo.map(v => ({
                id: v.id,
                title: v.title,
                subject: v.subject_name,
                price: parseFloat(v.price).toFixed(2),
                salesCount: parseInt(v.sales_count) || 0,
                revenue: parseFloat(v.video_revenue || 0).toFixed(2)
            })),
            payoutHistory: payoutHistory.map(p => ({
                id: p.id,
                amount: parseFloat(p.amount).toFixed(2),
                currency: p.currency || 'EUR',
                status: p.status,
                stripeTransferId: p.stripe_transfer_id,
                date: p.created_at
            }))
        });

    } catch (error) {
        console.error('Error getting scholar earnings:', error);
        res.status(500).json({ 
            message: 'Error retrieving earnings data', 
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
    getScholarEarnings
};
