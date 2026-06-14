import dotenv from "dotenv";
dotenv.config();

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

export default function corsMiddleware(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-uid, x-user-email");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
}