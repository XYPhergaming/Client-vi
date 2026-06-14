import dotenv from "dotenv";
dotenv.config();

export const razorpayConfig = {
  key_id: process.env.RAZORPAY_KEY_ID
};