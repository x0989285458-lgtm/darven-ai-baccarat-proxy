export function redactShadowErrorMessage(value) {
  return String(value ?? 'shadow process request failed')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED]')
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 500)
}
