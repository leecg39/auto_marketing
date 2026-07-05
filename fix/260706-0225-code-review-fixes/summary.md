# Fix Session Summary — 260706-0225

- 소스: 코드 리뷰(2026-07-06)에서 발견된 버그 4건
- Guard: `npm test`(113 pass) + `npm run check`(syntax) — 전부 통과
- 모드: Bounded (리뷰 발견 항목 전체)
- fix_score: 1.00 (error_reduction 4/4, guard_pass 4/4, anti-pattern 0건)

## 수정 내역

| ID | 심각도 | 내용 | 커밋 |
|----|--------|------|------|
| FIX-001 | Critical | CRM 수신 서버/서버리스에서 downstream fetch 실패 시 unhandled rejection으로 프로세스 크래시 → try/catch + `AbortSignal.timeout`(기본 5초, `DOWNSTREAM_CRM_TIMEOUT_MS`) + 서버 최상위 try/catch 추가. 실패는 `delivery: { ok: false, error }`로 응답에 포함 | b2578db |
| FIX-002 | Critical | 잘못 인코딩된 쿼리스트링(`%` 등)에서 `decodeURIComponent`가 URIError를 던져 `init()` 전체 실패 → `safeDecode`로 원문 유지 fallback. 회귀 테스트 추가 | 09ebb6e |
| FIX-003 | High | `normalizeDate` fallback이 `toISOString()`으로 UTC 변환하면서 KST 등 UTC+ 타임존에서 하루 밀림 → 로컬 연/월/일 직접 조합. `TZ=Asia/Seoul` 회귀 테스트 추가 | b638198 |
| FIX-004 | Medium | `localStorage` 접근이 throw하면(사파리 프라이빗 모드 등) 메모리 fallback을 건너뛰고 저장 무시 → `memoryStorage()` fallback 연결. 세션 내 consent/purchase dedupe 유지 테스트 추가 | b6ab521 |

## Blocked

- **BLK-001 (보안)**: `/crm/events` 무인증 + CORS `*`. 인증 방식(공유 시크릿 헤더 vs HMAC vs origin 화이트리스트)은 운영 CRM 연동 방식에 따라 달라지는 제품 결정이 필요해 자동 수정에서 제외. `blocked.md` 참고.

## 테스트 변화

- 110개 → 113개 (회귀 테스트 3건 추가)
- 기존 테스트 수정/삭제 없음 (anti-pattern 0건)
