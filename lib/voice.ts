export const voiceModels = [
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
  "eleven_multilingual_v2",
  "eleven_v3_conversational",
  "eleven_v4_turbo",
] as const;
export const expressiveVoice = (model: string) =>
  model === "eleven_v3_conversational" || model === "eleven_v4_turbo";
export const deliveryTags = {
  neutral: "",
  warm: "[warmly]",
  calm: "[calmly]",
  empathetic: "[sympathetic]",
  confident: "[confidently]",
  excited: "[excited]",
  serious: "[serious]",
} as const;
export const audioTagPattern =
  /\[(?:warmly|calmly|sympathetic|confidently|excited|serious|curious|whispers?|whispering|shouts?|shouting|laughs?|laughing|sighs?|sad|happy|angry|crying|chuckles|clears throat|short pause|long pause|pause)\]/gi;
export const withoutAudioTags = (text: string) =>
  text.replace(audioTagPattern, "").replace(/\s+/g, " ").trim();
