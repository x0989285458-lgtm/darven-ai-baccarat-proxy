export const EVENT_LAYERS = Object.freeze({
  CAPTURE: 'capture_error',
  WRITE: 'write_error',
  MONITOR: 'monitor_error',
  CONTROL: 'control_error',
})

export function classifyOperationalEvent({ component = '', message = '', statusCode = null, kind = '' } = {}) {
  const text = `${component} ${kind} ${message} ${statusCode ?? ''}`.toLowerCase()
  if (/control|unauthori[sz]ed|forbidden|401|403/.test(text)) return { layer: EVENT_LAYERS.CONTROL, severity: 'warn' }
  if (/supabase|persist|write|insert|upsert|rest\/v1|db|database/.test(text)) return { layer: EVENT_LAYERS.WRITE, severity: 'error' }
  if (/stale|過期|monitor|health|status|snapshot age/.test(text)) return { layer: EVENT_LAYERS.MONITOR, severity: 'warn' }
  if (/worker|capture|browser|snapshot|socket|timeout|abort|network|fetch|mt page/.test(text)) return { layer: EVENT_LAYERS.CAPTURE, severity: 'error' }
  return { layer: EVENT_LAYERS.MONITOR, severity: 'info' }
}

export function buildOperationalEvent({ component = 'system', message = '', statusCode = null, kind = '', metadata = {}, occurredAt = new Date().toISOString() } = {}) {
  const classified = classifyOperationalEvent({ component, message, statusCode, kind })
  return {
    eventLayer: classified.layer,
    eventSeverity: classified.severity,
    eventComponent: component,
    eventMessage: redactSecrets(message),
    eventStatusCode: statusCode,
    eventKind: kind || null,
    eventAt: occurredAt,
    eventMetadata: redactMetadata(metadata),
  }
}

export function toStatusEvent(event = {}) {
  return {
    eventLayer: event.eventLayer,
    eventSeverity: event.eventSeverity,
    eventComponent: event.eventComponent,
    eventMessage: event.eventMessage,
    eventStatusCode: event.eventStatusCode,
    eventKind: event.eventKind,
    eventAt: event.eventAt,
  }
}

export function redactSecrets(message = '') {
  return String(message)
    .replace(/token=([^\s&]+)/gi, 'token=[redacted]')
    .replace(/secret=([^\s&]+)/gi, 'secret=[redacted]')
    .replace(/(sb_secret_[A-Za-z0-9._-]+)/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
}

function redactMetadata(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactMetadata)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/token|secret|key|authorization/i.test(key)) return [key, '[redacted]']
    if (typeof item === 'string') return [key, redactSecrets(item)]
    return [key, redactMetadata(item)]
  }))
}
