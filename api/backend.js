import express from "express";
import dotenv from "dotenv";
import corsMiddleware from "./cors.js";
import { db } from "../utils/firebase.js";
import { doc, getDoc, updateDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { sendEmail } from "../utils/brevo.js";
import { askAI } from "../utils/openrouter.js";
import { razorpayConfig } from "../utils/razorpay.js";
import {
  isEmailRegistered,
  createOtpSession,
  processOtpVerification,
  processOtpResend,
  processLogin,
  getProducts,
  getCategories,
  getSocialSettings,
  getProductReviews,
  submitReview,
  createOrder,
  applyCoupon
} from "./script.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(corsMiddleware);

// আপনার Brevo ড্যাশবোর্ডে ভেরিফাইড ইমেইলটি এখানে দিন (বা environment variable-এ রাখুন)
const VERIFIED_BREVO_SENDER = process.env.BREVO_SENDER_EMAIL || "freefiregaming602433@gmail.com";

// Authentication Middleware (No admin SDK used)
async function requireAuth(req, res, next) {
  const uid = req.headers['x-user-uid'];
  if (!uid) {
    return res.status(401).json({ error: "Unauthorized. Authentication session required." });
  }
  req.userId = uid;
  next();
}

// Config retrieval (Razorpay)
app.get("/api/config", (req, res) => {
  res.json({
    razorpayKeyId: razorpayConfig.key_id
  });
});

// Deferred registration signup trigger
app.post("/api/auth/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required registration parameters." });
  }
  try {
    const exists = await isEmailRegistered(email);
    if (exists) {
      return res.status(400).json({ error: "This email is already registered." });
    }
    
    const otp = await createOtpSession(name, email, password);
    const sent = await sendEmail({
      // ✅ ফিক্সড: sender হিসেবে সর্বদা আপনার ভেরিফাইড ইমেইল এড্রেসটি যাবে
      sender: { name: "Shobdotori Bookstore", email: VERIFIED_BREVO_SENDER },
      to: [{ email: email.toLowerCase(), name }],
      subject: "Shobdotori Account Activation - OTP Verification",
      htmlContent: `
        <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #f1f5f9; border-radius: 1rem;">
          <h2 style="color: #9333ea; font-size: 20px; font-weight: bold; margin-bottom: 12px; text-align: center;">Activate Your Account</h2>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.5;">Hi ${name},</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.5;">Please verify your email using the 6-digit verification code below:</p>
          <div style="text-align: center; margin: 32px 0;">
            <span style="font-family: monospace; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #1e1b4b; background-color: #faf5ff; padding: 12px 24px; border-radius: 0.75rem; border: 2px dashed #e9d5ff; display: inline-block;">${otp}</span>
          </div>
          <p style="font-size: 12px; color: #9ca3af; text-align: center;">This OTP is valid for only 5 minutes.</p>
        </div>`
    });
    
    if (sent) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "Failed to dispatch email verification OTP." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verification step
app.post("/api/auth/verify", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: "Missing verification parameters." });
  }
  try {
    const result = await processOtpVerification(email, code);
    if (result.success) {
      res.json({ success: true, uid: result.uid, user: result.user });
    } else {
      res.status(400).json({ error: result.reason });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OTP resend triggers
app.post("/api/auth/resend-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Missing email parameter." });
  }
  try {
    const result = await processOtpResend(email);
    if (!result.success) {
      return res.status(400).json({ error: result.reason });
    }
    
    const sent = await sendEmail({
      // ✅ ফিক্সড: sender হিসেবে সর্বদা আপনার ভেরিফাইড ইমেইল এড্রেসটি যাবে
      sender: { name: "Shobdotori Bookstore", email: VERIFIED_BREVO_SENDER },
      to: [{ email: email.toLowerCase(), name: result.name }],
      subject: "Shobdotori Account Activation - OTP Verification",
      htmlContent: `
        <div style="font-family: Inter, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #f1f5f9; border-radius: 1rem;">
          <h2 style="color: #9333ea; font-size: 20px; font-weight: bold; margin-bottom: 12px; text-align: center;">New Activation OTP</h2>
          <div style="text-align: center; margin: 32px 0;">
            <span style="font-family: monospace; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #1e1b4b; background-color: #faf5ff; padding: 12px 24px; border-radius: 0.75rem; border: 2px dashed #e9d5ff; display: inline-block;">${result.otp}</span>
          </div>
        </div>`
    });
    
    if (sent) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "Failed to transmit OTP code." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User Session logins
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Missing login parameters." });
  }
  try {
    const result = await processLogin(email, password);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.reason });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Profile
app.post("/api/auth/update-profile", requireAuth, async (req, res) => {
  const { name, phone, address, city, zip } = req.body;
  try {
    const userRef = doc(db, 'users', req.userId);
    await updateDoc(userRef, { name, phone, address, city, zip });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retrieve profile
app.get("/api/auth/profile", requireAuth, async (req, res) => {
  try {
    const snap = await getDoc(doc(db, 'users', req.userId));
    if (snap.exists()) {
      res.json({ success: true, user: snap.data() });
    } else {
      res.status(404).json({ error: "User profile target document not found." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📌 CATALOG OPERATIONS (Lighthouse Edge CDN Cache headers added)
app.get("/api/products", async (req, res) => {
  try {
    const p = await getProducts();
    // Vercel global Edge CDN Caching (10 mins hard cache, background revalidation)
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const c = await getCategories();
    // Vercel global Edge CDN Caching
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
    res.json(c);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/socials", async (req, res) => {
  try {
    const s = await getSocialSettings();
    // Vercel global Edge CDN Caching
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200');
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reviews Retrieval
app.get("/api/reviews/:productId", async (req, res) => {
  try {
    const r = await getProductReviews(req.params.productId);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Review
app.post("/api/reviews", requireAuth, async (req, res) => {
  const { productId, rating, text } = req.body;
  if (!productId || !rating || !text) {
    return res.status(400).json({ error: "Missing review body properties." });
  }
  try {
    const userSnap = await getDoc(doc(db, 'users', req.userId));
    if (!userSnap.exists()) return res.status(404).json({ error: "User profile target not found." });
    
    const uData = userSnap.data();
    const result = await submitReview(productId, req.userId, uData.name, rating, text);
    res.json({ success: true, metrics: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Coupons logic
app.post("/api/coupons/apply", async (req, res) => {
  const { code, subtotal } = req.body;
  try {
    const discount = await applyCoupon(code, subtotal);
    res.json({ success: true, discount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Save Order & Dispatch Invoice
app.post("/api/orders", async (req, res) => {
  const { customer, items, subtotal, discount, shipping, total, paymentId } = req.body;
  try {
    const orderId = await createOrder(customer, items, subtotal, discount, shipping, total, paymentId);
    
    let orderListHTML = "";
    const pList = await getProducts();
    items.forEach(it => {
      const prod = pList.find(p => p.id === it.id);
      if (prod) {
        orderListHTML += `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-size: 13px; color: #1e293b;">${prod.name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-size: 13px; color: #1e293b; text-align: center;">${it.qty}</td>
            <td style="padding: 8px; border-bottom: 1px solid #f1f5f9; font-size: 13px; color: #1e293b; text-align: right;">₹${(prod.price * it.qty).toFixed(2)}</td>
          </tr>`;
      }
    });

    await sendEmail({
      // ✅ ফিক্সড: sender হিসেবে সর্বদা আপনার ভেরিফাইড ইমেইল এড্রেসটি যাবে
      sender: { name: "Shobdotori Bookstore", email: VERIFIED_BREVO_SENDER },
      to: [{ email: customer.email, name: customer.name }],
      subject: `Order Confirmed: #${orderId.toUpperCase()}`,
      htmlContent: `
        <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #f1f5f9; border-radius: 1rem;">
          <h2 style="color: #9333ea; font-size: 20px; font-weight: bold; margin-bottom: 4px;">Thank You for Your Purchase!</h2>
          <p style="font-size: 12px; color: #9ca3af; margin-bottom: 24px;">Order ID: #${orderId.toUpperCase()}</p>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background-color: #faf5ff;">
                <th style="padding: 8px; text-align: left; font-size: 12px; color: #7e22ce; font-weight: bold;">Book Title</th>
                <th style="padding: 8px; text-align: center; font-size: 12px; color: #7e22ce; font-weight: bold;">Qty</th>
                <th style="padding: 8px; text-align: right; font-size: 12px; color: #7e22ce; font-weight: bold;">Price</th>
              </tr>
            </thead>
            <tbody>
              ${orderListHTML}
            </tbody>
          </table>
          <div style="text-align: right; margin-bottom: 32px;">
            <p style="font-size: 12px; color: #6b7280; margin: 4px 0;">Shipping Quote: ₹${shipping.toFixed(2)}</p>
            <h3 style="font-size: 16px; color: #1e1b4b; margin: 8px 0; font-weight: 800;">Charged: ₹${total.toFixed(2)}</h3>
          </div>
        </div>`
    });

    res.json({ success: true, orderId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Retrieve Active Orders
app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const userEmail = req.headers['x-user-email'];
    const snap = await getDocs(query(collection(db, 'orders'), where('customer.email', '==', userEmail), orderBy('createdAt', 'desc')));
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat Dialog Channels (Admin live chat/AI Assist)
app.post("/api/chat/message", async (req, res) => {
  const { mode, text, history, userId } = req.body;
  try {
    if (mode === 'ai') {
      const messages = [
        { role: "system", content: "You are Shobdotori Bookstore AI Assistant. Answer questions beautifully, help pick books based on author or name, and keep responses short and friendly in English." },
        ...history
      ];
      const botResponse = await askAI(messages);
      if (botResponse && botResponse.choices && botResponse.choices[0].message) {
        res.json({ success: true, text: botResponse.choices[0].message.content });
      } else {
        res.status(500).json({ error: "AI communications failure." });
      }
    } else {
      if (!userId) return res.status(400).json({ error: "Missing identification metrics." });
      const ref = collection(db, `chats/${userId}/messages`);
      await addDoc(ref, { text, sender: 'user', timestamp: new Date() });
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default app;