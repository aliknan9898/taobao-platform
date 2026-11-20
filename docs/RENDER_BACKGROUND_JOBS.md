# Render background-job ownership

KINAN runs scheduled tasks inside the web process. If two Render web services
run the same code, both can trigger supplier imports, shipping checks, notifications,
and other scheduled work. This can waste supplier API quotas and duplicate actions.

Set `KINAN_BACKGROUND_JOBS_ENABLED=0` on a **passive** web instance to skip
the `startJobs()` scheduler. The default (unset or any other value) is enabled,
so this code change does not alter production behavior until configured.

Before enabling this on a passive service:
1. Confirm the retained service is healthy and runs its required scheduled tasks.
2. Review all webhooks, OAuth callbacks, and external integration URLs.
3. Back up and compare both services' data stores; do not assume local JSON
   files are shared with PostgreSQL.
4. Change only the passive instance's variable through Render's secure dashboard.
5. Verify logs show `[jobs] scheduled background jobs disabled for this instance`.
6. Verify no independently scheduled tasks exist outside `startJobs()`.
7. Keep the old service available until migration and rollback are verified.

**Warning:** This disables scheduled payment reconciliation and other important
background tasks on that instance, not merely CJ/AliExpress import jobs. It does
not stop manual API requests, webhooks, or external cron triggers. Never disable
scheduled jobs on the only active instance.
