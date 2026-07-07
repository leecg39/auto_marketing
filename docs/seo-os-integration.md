# SEO Office(seo-os) 연동 설계 — 마케팅 자동화 통합

`seo-os/`는 [AgriciDaniel/seo-os](https://github.com/AgriciDaniel/seo-os)를 클론해 설치한
로컬 우선(local-first) SEO 에이전시 운영 시스템입니다. 25개 AI 스페셜리스트가 기술
감사, 키워드 리서치, 콘텐츠 전략을 수행하고 결과를 클라이언트별 second brain
(`.seo-office/vaults/<client>/`)에 마크다운으로 축적합니다.

이 문서는 seo-os와 이 마케팅 자동화 키트(auto-marketing)를 어떻게 잇는지,
그리고 어떤 한글 패치를 적용했는지 기록합니다.

## 1. 왜 연결하는가

두 시스템은 퍼널의 서로 다른 반쪽을 담당합니다.

| 시스템 | 담당 | 산출물 |
|--------|------|--------|
| seo-os | 유입(acquisition): 기술 SEO, 키워드, 콘텐츠, GEO/AI 검색 | brain vault의 감사·전략 노트 |
| marketing-automation-kit | 전환·유지(conversion/retention): GA4 전자상거래 이벤트, 광고 전환, CRM 자동화 플로우 | dataLayer 이벤트, automation_actions, 매출 대조 리포트 |

연동 없이는 "SEO로 데려온 방문자가 전환·재구매까지 이어지는지"를 한 화면에서 볼 수
없습니다. 연동 후에는 seo-os 오케스트레이터가 SEO 감사와 함께 **마케팅 자동화 준비
상태를 같은 brain에 기록**하므로, 콘텐츠 전략 노트 옆에 전환 파이프라인 증거가
남습니다.

## 2. 아키텍처

연결 지점은 키트가 이미 노출하는 **읽기 전용에 가까운 두 API**입니다. 키트 코드는
전혀 수정하지 않았습니다.

```
┌────────────────────────────────────────────────────┐
│ seo-os (localhost:3000)                            │
│                                                    │
│  오케스트레이터 ──▶ 마케팅 자동화 분석가              │
│                     (marketing-automation 스페셜리스트)│
│                        │                           │
│          ┌─────────────┴──────────────┐            │
│          ▼                            ▼            │
│  GET /api/marketing/env-status   POST /api/crm/events│
│  (GTM/GA4/광고/CRM env 준비)      (프로브 이벤트 →    │
│                                   automation_actions)│
└──────────┼────────────────────────────┼────────────┘
           ▼                            ▼
   marketing-automation-kit 배포 (Vercel production 또는 vercel dev)
           │
           ▼
   한국어 감사 리포트 → .seo-office/vaults/<client>/wiki/audits/
   (hot.md 갱신, log.md 추가, SQLite 재색인, HTML 리포트)
```

### 프로브 설계 원칙

- **이벤트는 `login`만 사용**: 연락처(email/phone)가 없어 키트의 동의 검증
  (`marketing_consent_required_for_contact_payload`)에 걸리지 않고, 메시지 발송
  액션이 아닌 audience 갱신 액션만 생성되므로 downstream 발송툴 큐를 오염시키지
  않습니다. `metadata.probe: true`로 마킹됩니다.
- **타임아웃 8초 + AbortSignal 연동**: 키트 배포가 죽어 있어도 스페셜리스트가
  매달리지 않고, 오케스트레이터의 취소 신호를 그대로 존중합니다.
- **3가지 실패 모드 준수** (seo-os 규약):
  - `MARKETING_KIT_BASE_URL` 미설정 → SoftSkip(노랑) — 시스템 오류가 아니라 미연결
  - 두 API 모두 연결 불가 → SoftSkip(노랑) — 배포 상태 확인 안내
  - 한쪽만 성공 → 결과는 기록하되 `degraded: true`로 신뢰도 하향

## 3. 적용한 한글 패치 (seo-os 저장소 내 로컬 커밋)

| 파일 | 내용 |
|------|------|
| `src/lib/specialists/marketing-automation.ts` | 신규 스페셜리스트 "마케팅 자동화 분석가". 리포트 본문·진행 메시지·요약 전부 한국어 |
| `src/lib/specialists/catalog.ts` | 카탈로그 등록 (한국어 이름/설명, `uses: ["marketing-kit"]`) |
| `src/lib/specialists/index.ts` | 배럴에 등록 (오케스트레이터가 인식) |
| `src/lib/integrations/catalog.ts` | `marketing-kit` 인테그레이션 카드 추가 → /setup 화면에서 `MARKETING_KIT_BASE_URL` 입력 가능 |
| `src/lib/specialists/_lib/freshness.ts` | 신선도 TTL 14일 등록 (env/CRM 상태는 배포마다 낡으므로 검증 패스와 동일 주기) |
| `.env.example` | `MARKETING_KIT_BASE_URL` 한국어 안내 추가 |
| `src/lib/specialists/__tests__/marketing-automation.test.ts` | 순수 헬퍼 5개 테스트 (URL 해석, 프로브 페이로드, 한국어 리포트 렌더링 3분기) |

검증 결과: `pnpm typecheck` 통과, `pnpm lint` 오류 0건, `pnpm test` 209개 중 208개
통과. 유일한 실패(`Marketing Brain script smoke`)는 패치 전부터 존재하는 upstream
문제(vendored Python 스크립트가 Python 3.14와 비호환)로, 이번 패치와 무관함을
스태시 후 재실행으로 확인했습니다.

## 4. 사용 방법

```bash
# 1. seo-os 실행 (이미 설치됨 — pnpm install 완료)
cd marketing-automation-kit/seo-os
pnpm dev
# http://localhost:3000/setup 접속

# 2. /setup 에서
#    - LLM 프로바이더 선택 (claude/codex/gemini CLI 중 설치된 것)
#    - "Marketing Automation Kit" 카드에 배포 URL 입력:
#      https://auto-marketing-sigma.vercel.app

# 3. 클라이언트 추가 후 오케스트레이터 채팅에서 실행:
#    "run marketing-automation" 또는 데스크 클릭
```

리포트는 `.seo-office/vaults/<client>/wiki/audits/<날짜>-marketing-automation.md`
(+ HTML 리포트)로 저장되고, brain 그래프에 노드로 나타납니다.

### 리포트에 담기는 내용

1. **운영 env 준비 상태** — 준비/누락/placeholder/형식 오류 키 목록과 다음 단계.
   현재 배포 기준 남은 값: `DOWNSTREAM_CRM_WEBHOOK_URL`,
   `NEXT_PUBLIC_GOOGLE_ADS_PURCHASE_LABEL`, `NEXT_PUBLIC_META_PIXEL_ID`
2. **남은 외부 계정 작업** — 키트의 next_actions(한국어)를 그대로 승계, 실행 전
   확인 필요 여부 표시
3. **CRM 자동화 파이프라인 프로브** — 플로우 매핑, automation_actions 생성 수,
   downstream 전달 상태(성공/생략/실패)
4. **SEO 연계 권장 액션** — UTM 명명 규칙 ↔ SDK 어트리뷰션 연결, GA4 ID 일치 확인,
   `reconcile:revenue` 매출 대조, 콘텐츠 리드 캡처 → `lead_followup` 플로우 연결

## 5. 확장 로드맵 (다음 단계 후보)

1. **GA4 교차 검증**: seo-os의 `google-analytics` 스페셜리스트(gcloud OAuth)가 읽는
   GA4 organic 세션과 키트 `reconcile:revenue`의 purchase 매출을 같은 리포트에서
   대조 — "SEO 유입 → 구매 전환율" 지표 산출
2. **콘텐츠 → 리드 파이프라인**: `content-brief-generator`가 만든 브리프에 리드
   캡처 CTA 섹션과 `trackGenerateLead` 스니펫을 자동 포함
3. **키워드 → UTM 캠페인 생성기**: `keyword-researcher` 결과에서 우선순위 키워드를
   골라 키트 어트리뷰션 파라미터 규칙에 맞는 UTM 템플릿 생성
4. **드리프트 연동**: `drift-monitor`가 감지한 사이트 변경 시 마케팅 자동화 분석가를
   자동 재실행해 dataLayer 회귀를 조기 발견

## 6. 저장소 관리 방침

- `seo-os/`는 독립 git 저장소(upstream: AgriciDaniel/seo-os, AGPL-3.0)이므로 킷
  저장소에서는 `.gitignore`로 제외합니다. 한글 패치는 seo-os 저장소 안에 로컬
  커밋으로 보존됩니다.
- upstream을 갱신하려면: `cd seo-os && git stash → git pull --rebase → 충돌 해결`.
  패치 파일이 7개뿐이고 대부분 신규 파일이라 충돌 가능성은 낮습니다.
- AGPL-3.0: 패치본을 네트워크 서비스로 외부 제공할 경우 소스 공개 의무가
  있습니다. 현재는 로컬 사용이므로 해당 없음.
