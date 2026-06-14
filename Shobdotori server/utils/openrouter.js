import dotenv from "dotenv";
dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

export async function askAI(messages) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Shobdotori Bookstore"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: messages
      })
    });
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error communicating with OpenRouter:", error);
    return null;
  }
}