import { createHmac, randomBytes } from "node:crypto";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function digestSecret(value, hmacKey) {
    return createHmac("sha256", hmacKey).update(value).digest("hex");
}
export function generateConnectionCode() {
    const bytes = randomBytes(8);
    let code = "";
    for (let index = 0; index < 8; index += 1) {
        code += CODE_ALPHABET[bytes[index] & 31];
    }
    return code;
}
export function normalizeConnectionCode(value) {
    return value.toUpperCase().replace(/[\s-]/g, "");
}
