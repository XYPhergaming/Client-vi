import { db, auth } from "../utils/firebase.js";
import { doc, getDoc, setDoc, updateDoc, addDoc, getDocs, collection, query, where, orderBy, limit, serverTimestamp, increment } from "firebase/firestore";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile } from "firebase/auth";
import { sendEmail } from "../utils/brevo.js";

// Helper to generate a 6-digit OTP
export function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Logic: Check if email already exists in users collection
export async function isEmailRegistered(email) {
  const q = query(collection(db, 'users'), where('email', '==', email.toLowerCase()), limit(1));
  const snap = await getDocs(q);
  return !snap.empty;
}

// Logic: Create dynamic validation OTP sequence and write to Firestore
export async function createOtpSession(name, email, password) {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins
  
  const pendingData = {
    name,
    email: email.toLowerCase(),
    password: password,
    otp,
    expiresAt,
    createdAt: new Date()
  };

  await setDoc(doc(db, 'otps', email.toLowerCase()), pendingData);
  return otp;
}

// Logic: Verify OTP and create Firebase Auth account
export async function processOtpVerification(email, code) {
  const otpRef = doc(db, 'otps', email.toLowerCase());
  const snap = await getDoc(otpRef);
  if (!snap.exists()) {
    return { success: false, reason: "No active verification session found." };
  }
  
  const data = snap.data();
  if (!data.expiresAt || !data.otp) {
    return { success: false, reason: "Invalid verification state." };
  }
  
  const expiry = new Date(data.expiresAt);
  if (new Date() >= expiry) {
    return { success: false, reason: "The verification code has expired. Please sign up again." };
  }
  
  if (data.otp !== code) {
    return { success: false, reason: "Incorrect verification code entered." };
  }

  // OTP validated, now create account in Firebase Auth
  try {
    const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
    await updateProfile(cred.user, { displayName: data.name });
    
    // Create user profile in Firestore
    const userPayload = {
      name: data.name,
      email: data.email,
      phone: '',
      address: '',
      city: '',
      zip: '',
      registeredAt: new Date(),
      verified: true,
      cart: [],
      wishlist: []
    };
    
    await setDoc(doc(db, 'users', cred.user.uid), userPayload);
    await setDoc(otpRef, {}); // clear OTP session
    
    return { success: true, uid: cred.user.uid, user: userPayload };
  } catch (authErr) {
    console.error("Firebase registration failure during OTP verification:", authErr);
    return { success: false, reason: authErr.message || "Registration failed." };
  }
}

// Logic: Resend OTP sequence
export async function processOtpResend(email) {
  const otpRef = doc(db, 'otps', email.toLowerCase());
  const snap = await getDoc(otpRef);
  if (!snap.exists()) {
    return { success: false, reason: "No pending registration session found. Please sign up again." };
  }
  
  const data = snap.data();
  if (data.createdAt) {
    const lastSent = new Date(data.createdAt);
    const differenceSeconds = (Date.now() - lastSent.getTime()) / 1000;
    if (differenceSeconds < 60) {
      return { success: false, reason: `Rate Limit Active: Please wait ${Math.ceil(60 - differenceSeconds)}s.` };
    }
  }

  const newOtp = generateOTP();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  
  await updateDoc(otpRef, {
    otp: newOtp,
    expiresAt: expiresAt,
    createdAt: new Date()
  });

  return { success: true, name: data.name, otp: newOtp };
}

// Logic: User login validation
export async function processLogin(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const userRef = doc(db, 'users', cred.user.uid);
    const userSnap = await getDoc(userRef);
    
    if (userSnap.exists()) {
      const uData = userSnap.data();
      if (uData.verified === false) {
        return { success: true, needsVerification: true, name: uData.name || "Customer", uid: cred.user.uid };
      }
      return { success: true, needsVerification: false, uid: cred.user.uid, user: uData };
    }
    
    return { success: true, needsVerification: false, uid: cred.user.uid, user: { email, name: cred.user.displayName } };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// Logic: Retrieve products and categories
export async function getProducts() {
  const snap = await getDocs(query(collection(db, 'products'), orderBy('createdAt', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getCategories() {
  const snap = await getDocs(query(collection(db, 'categories'), orderBy('createdAt', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getSocialSettings() {
  const snap = await getDoc(doc(db, 'settings', 'socials'));
  return snap.exists() ? snap.data() : {};
}

// Logic: Retrieve/Submit reviews
export async function getProductReviews(productId) {
  try {
    let snap;
    try {
      const q = query(collection(db, 'reviews'), where('productId', '==', productId), orderBy('createdAt', 'desc'));
      snap = await getDocs(q);
    } catch (e) {
      console.warn("Index not ready yet, using clientside sort fallback.");
      const qFallback = query(collection(db, 'reviews'), where('productId', '==', productId));
      snap = await getDocs(qFallback);
    }
    
    const reviewsList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    reviewsList.sort((a, b) => {
      const tA = a.createdAt ? (a.createdAt.seconds || 0) : 0;
      const tB = b.createdAt ? (b.createdAt.seconds || 0) : 0;
      return tB - tA;
    });
    return reviewsList;
  } catch (err) {
    console.error("Error retrieving reviews:", err);
    throw err;
  }
}

export async function submitReview(productId, userId, userName, rating, text) {
  const existingQuery = query(collection(db, 'reviews'), where('productId', '==', productId), where('userId', '==', userId), limit(1));
  const snapCheck = await getDocs(existingQuery);
  if (!snapCheck.empty) {
    throw new Error("Duplicate Review Blocked: You have already reviewed this book.");
  }

  const reviewPayload = {
    productId,
    userId,
    userName,
    rating: Number(rating),
    text: text.trim(),
    createdAt: new Date()
  };

  await addDoc(collection(db, 'reviews'), reviewPayload);

  // Recalculate Average Rating
  const allReviewsQuery = query(collection(db, 'reviews'), where('productId', '==', productId));
  const reviewSnap = await getDocs(allReviewsQuery);
  
  let totalRating = 0;
  let reviewCount = reviewSnap.size;
  reviewSnap.forEach(docSnap => {
    totalRating += docSnap.data().rating;
  });

  const averageRating = reviewCount > 0 ? (totalRating / reviewCount) : 0;

  await updateDoc(doc(db, 'products', productId), {
    averageRating: parseFloat(averageRating.toFixed(2)),
    reviewCount: reviewCount
  });

  return { averageRating, reviewCount };
}

// Logic: Create Order
export async function createOrder(customer, items, subtotal, discount, shipping, total, paymentId) {
  // Check stock availability
  for (const it of items) {
    const prodRef = doc(db, 'products', it.id);
    const prodSnap = await getDoc(prodRef);
    if (prodSnap.exists()) {
      const prodData = prodSnap.data();
      if (prodData.stock !== undefined && prodData.stock !== null && prodData.stock !== '') {
        const stock = Number(prodData.stock);
        if (stock < it.qty) {
          throw new Error(`Insufficient Stock: "${prodData.name}" only has ${stock} copies left.`);
        }
      }
    }
  }

  const orderPayload = {
    customer,
    items,
    subtotal,
    discount,
    shipping,
    total,
    status: 'pending',
    paymentId,
    createdAt: new Date()
  };

  const docRef = await addDoc(collection(db, 'orders'), orderPayload);

  // Deduct stock
  for (const it of items) {
    const prodRef = doc(db, 'products', it.id);
    await updateDoc(prodRef, {
      stock: increment(-it.qty)
    });
  }

  return docRef.id;
}

// Logic: Apply Promo Coupons
export async function applyCoupon(code, subtotal) {
  const couponQuery = query(collection(db, 'coupons'), where('code', '==', code.toUpperCase()), limit(1));
  const snap = await getDocs(couponQuery);
  if (snap.empty) {
    throw new Error("Invalid promo coupon code.");
  }
  
  const couponData = snap.docs[0].data();
  const expiry = couponData.expiryDate.toDate();
  if (new Date() > expiry) {
    throw new Error("This promo coupon has expired.");
  }
  
  if (subtotal < couponData.minimumOrder) {
    throw new Error(`Minimum order of ₹${couponData.minimumOrder} is required.`);
  }
  
  return couponData.discount;
}