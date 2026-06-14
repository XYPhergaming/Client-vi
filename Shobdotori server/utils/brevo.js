import dotenv from "dotenv";
dotenv.config();

const BREVO_API_KEY = process.env.BREVO_API_KEY;

export async function sendEmail({ sender, to, subject, htmlContent }) {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sender, to, subject, htmlContent })
    });
    return response.ok;
  } catch (error) {
    console.error("Error sending email via Brevo:", error);
    return false;
  }
}