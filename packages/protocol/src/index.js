export function assertNonEmptyString(value, fieldName) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Expected non-empty string for ${fieldName}`);
    }
    return value;
}
