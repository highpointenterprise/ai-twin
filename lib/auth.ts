import { z } from "zod";
export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(128, "Use no more than 128 characters.");
export const proofSchema = z.object({ currentPassword: z.string().min(1).max(128), code: z.string().trim().max(32).optional() });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password.").max(128), code: z.string().trim().max(32).optional() });
export const signupSchema = z.object({ name: z.string().trim().min(1, "Enter your name.").max(80), email: emailSchema, password: passwordSchema });
export const emailRequestSchema = z.object({ email: emailSchema });
export const actionTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is invalid or expired.") });
export const resetPasswordSchema = actionTokenSchema.extend({ password: passwordSchema });
export const profileSchema = signupSchema.pick({ name: true });
export const changePasswordSchema = proofSchema.extend({ password: passwordSchema });
export const changeEmailSchema = proofSchema.extend({ email: emailSchema });
export interface AuthUser { id: string; name: string; email: string; emailVerified: boolean; mfaEnabled: boolean }
export interface AuthSession { user: AuthUser; token: string; expiresAt: string }
export interface AccountSession { id: string; current: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string }
export interface SecurityEvent { id: string; action: string; createdAt: string }
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
