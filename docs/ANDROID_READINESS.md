# KINAN Android readiness

Reviewed baseline: `d859413d62982b9bbc83386febb0b490a838e516`.

| Area | Verified or observed | Remaining validation |
| --- | --- | --- |
| Backend | Node.js 22 suite: 364 tests, 359 passed, 5 conditional suites skipped, 0 failures. The follow-up PostgreSQL 16 run passed all 64 tests and subtests with no skips. Isolated smoke: 9 checks passed with background jobs disabled. | Verify production backup restoration and staging migrations before any production data change. |
| Shop and Seller | Live `/shop` and `/seller` returned HTTP 200. Flutter uses those existing web flows. | Android device QA for Arabic/RTL, sign-in and session switching, search, product submission, file selection, invoices and browser handoffs. |
| Administration and warehouse | `/admin`, `/warehouse` and the unauthorized admin API were covered by isolated smoke. | Keep staff workflows on the web; test warehouse scanning and Libya fulfilment with staff test accounts. |
| Supplier imports | Public config showed AliExpress, CJ and AI enabled, Banggood disabled. TaoWorld returned an onboarding error in the Seller screen even though the integration reports an account connected. | Validate product previews in staging. Complete TaoWorld onboarding or choose a separate procurement provider. |
| Payments | The live public config returned `payments_paused: true`. | Verify checkout, Stripe webhooks and browser handoff with Stripe test credentials before any release decision. |
| Push notifications | The native registration endpoint accepts Expo push tokens. | A native Flutter notifications implementation needs its own registration and delivery integration. |

The first Android candidate is a Flutter shell for the existing Shop and Seller web flows. Backend role permissions and review rules still apply. Public endpoint checks were read-only. No live orders, payments, database writes, deployment or production configuration changes were performed.
