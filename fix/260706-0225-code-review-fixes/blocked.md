# Blocked Items — 260706-0225

## BLK-001: CRM 이벤트 엔드포인트 무인증 + CORS `*`

- 대상: `server/crm-event-receiver.mjs`, `api/crm/events.js`
- 위험: downstream webhook 연결 시 제3자가 가짜 이벤트로 이메일/카카오 발송 큐 오염, downstream API 쿼터 소진, PII 수신 표면 개방
- 자동 수정 제외 이유: 인증 방식이 제품 결정 사항
  - 옵션 A — 공유 시크릿 헤더: 브라우저 SDK가 호출하므로 시크릿이 클라이언트에 노출됨. 스팸 억제 효과는 제한적이나 저비용
  - 옵션 B — CORS를 `NEXT_PUBLIC_APP_URL`로 고정 + rate limiting: 브라우저 오리진 기반 억제. 서버-서버 호출에는 무효
  - 옵션 C — Vercel 미들웨어/에지에서 origin+rate limit 조합: 권장하지만 배포 구조 변경 필요
- 권장 최소 조치: `CORS_ALLOW_ORIGIN`을 운영 도메인으로 고정(env는 이미 지원됨) + downstream 연결 전 rate limiting 도입
