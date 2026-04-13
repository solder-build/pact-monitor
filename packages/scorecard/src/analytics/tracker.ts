const ANALYTICS_URL = "/api/v1/analytics/events";

const sessionId = crypto.randomUUID();

export function track(eventType: string, data: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({
    event_type: eventType,
    event_data: data,
    session_id: sessionId,
    source: "scorecard",
  });

  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ANALYTICS_URL, payload);
    } else {
      fetch(ANALYTICS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {});
    }
  } catch {
    // Never break the app for analytics
  }
}
