const nodemailer = require('nodemailer');

// Create transporter using environment variables
// For Gmail, you need to use an App Password (not your regular password)
// Go to Google Account > Security > 2-Step Verification > App Passwords
const createTransporter = () => {
    return nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD, // For Gmail, use App Password
        },
    });
};

/**
 * Send password reset email
 * @param {string} to - Recipient email
 * @param {string} resetUrl - Password reset URL with token
 * @param {string} userName - User's name for personalization
 */
const sendPasswordResetEmail = async (to, resetUrl, userName = 'User') => {
    const transporter = createTransporter();

    const mailOptions = {
        from: `"Uniclips" <${process.env.EMAIL_USER || 'noreply@uniclips.com'}>`,
        to: to,
        subject: 'Password Reset Request - Uniclips',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Password Reset</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 28px;">🔑 Password Reset</h1>
                </div>
                
                <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
                    <p style="font-size: 16px;">Hi <strong>${userName}</strong>,</p>
                    
                    <p style="font-size: 16px;">We received a request to reset your password for your Uniclips account. Click the button below to create a new password:</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-size: 16px; font-weight: bold; display: inline-block;">Reset Password</a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">If the button doesn't work, copy and paste this link into your browser:</p>
                    <p style="font-size: 12px; color: #888; word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 5px;">${resetUrl}</p>
                    
                    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
                    
                    <p style="font-size: 14px; color: #666;">⏰ This link will expire in <strong>1 hour</strong> for security reasons.</p>
                    
                    <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
                    
                    <p style="font-size: 14px; color: #999; margin-top: 30px;">
                        Best regards,<br>
                        <strong>The Uniclips Team</strong>
                    </p>
                </div>
                
                <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
                    <p>© ${new Date().getFullYear()} Uniclips. All rights reserved.</p>
                    <p>This is an automated message. Please do not reply to this email.</p>
                </div>
            </body>
            </html>
        `,
        text: `
Hi ${userName},

We received a request to reset your password for your Uniclips account.

Click the link below to create a new password:
${resetUrl}

This link will expire in 1 hour for security reasons.

If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.

Best regards,
The Uniclips Team
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Password reset email sent:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Error sending password reset email:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Verify email configuration
 */
const verifyEmailConfig = async () => {
    try {
        const transporter = createTransporter();
        await transporter.verify();
        console.log('Email configuration is valid');
        return true;
    } catch (error) {
        console.error('Email configuration error:', error.message);
        return false;
    }
};

/**
 * Send Stripe verification required email
 * @param {string} to - Recipient email
 * @param {string} verificationUrl - URL to complete Stripe verification
 * @param {string} userName - User's name for personalization
 * @param {Array} requirements - List of pending requirements
 */
const sendStripeVerificationEmail = async (to, verificationUrl, userName = 'Scholar', requirements = []) => {
    const transporter = createTransporter();

    const requirementsList = requirements.length > 0 
        ? requirements.map(r => `<li>${r.replace(/_/g, ' ')}</li>`).join('')
        : '<li>Identity verification</li>';

    const mailOptions = {
        from: `"Uniclips" <${process.env.EMAIL_USER || 'noreply@uniclips.com'}>`,
        to: to,
        subject: 'Action Required: Complete Your Stripe Verification - Uniclips',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Stripe Verification Required</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #635bff 0%, #8b5cf6 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 28px;">💳 Verification Required</h1>
                </div>
                
                <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
                    <p style="font-size: 16px;">Hi <strong>${userName}</strong>,</p>
                    
                    <p style="font-size: 16px;">Great news! Your Stripe account is almost ready. To start receiving payouts for your course sales, Stripe requires some additional verification:</p>
                    
                    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                        <strong style="color: #92400e;">Pending Requirements:</strong>
                        <ul style="color: #92400e; margin: 10px 0 0 0; padding-left: 20px;">
                            ${requirementsList}
                        </ul>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${verificationUrl}" style="background: linear-gradient(135deg, #635bff 0%, #8b5cf6 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-size: 16px; font-weight: bold; display: inline-block;">Complete Verification</a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">If the button doesn't work, copy and paste this link into your browser:</p>
                    <p style="font-size: 12px; color: #888; word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 5px;">${verificationUrl}</p>
                    
                    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
                    
                    <p style="font-size: 14px; color: #666;">⏰ Please complete this verification soon to avoid any delays in receiving your earnings.</p>
                    
                    <p style="font-size: 14px; color: #666;">This is a secure link powered by Stripe. Your information is protected with bank-level security.</p>
                    
                    <p style="font-size: 14px; color: #999; margin-top: 30px;">
                        Best regards,<br>
                        <strong>The Uniclips Team</strong>
                    </p>
                </div>
                
                <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
                    <p>© ${new Date().getFullYear()} Uniclips. All rights reserved.</p>
                    <p>This is an automated message. Please do not reply to this email.</p>
                </div>
            </body>
            </html>
        `,
        text: `
Hi ${userName},

Great news! Your Stripe account is almost ready. To start receiving payouts for your course sales, Stripe requires some additional verification.

Click the link below to complete your verification:
${verificationUrl}

Please complete this verification soon to avoid any delays in receiving your earnings.

Best regards,
The Uniclips Team
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Stripe verification email sent:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('Error sending Stripe verification email:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    sendPasswordResetEmail,
    verifyEmailConfig,
    sendStripeVerificationEmail
};
