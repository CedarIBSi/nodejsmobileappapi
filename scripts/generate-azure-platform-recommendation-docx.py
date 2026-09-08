"""Generates the Azure platform (PaaS) recommendation brief.

Companion to generate-azure-server-recommendation-docx.py, which describes the
single-VM option. Both documents are kept so IT can compare them side by side.
"""
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "IBS_Mobile_API_Azure_Platform_Recommendation.docx"


def bullets(document: Document, values: list[str]) -> None:
    for value in values:
        document.add_paragraph(value, style="List Bullet")


def numbered(document: Document, values: list[str]) -> None:
    for value in values:
        document.add_paragraph(value, style="List Number")


def table(document: Document, headers: list[str], rows: list[list[str]]) -> None:
    item = document.add_table(rows=1, cols=len(headers))
    item.style = "Table Grid"
    for index, header in enumerate(headers):
        cell = item.rows[0].cells[index]
        cell.text = header
        for run in cell.paragraphs[0].runs:
            run.bold = True
    for row in rows:
        cells = item.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = value


doc = Document()
section = doc.sections[0]
section.top_margin = Inches(0.65)
section.bottom_margin = Inches(0.65)
section.left_margin = Inches(0.75)
section.right_margin = Inches(0.75)
doc.styles["Normal"].font.name = "Aptos"
doc.styles["Normal"].font.size = Pt(10.5)

title = doc.add_heading("IBS Intelligence Mobile API", 0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
subtitle = doc.add_paragraph("Azure Platform Recommendation - Managed Services Design")
subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
date = doc.add_paragraph("Prepared: 7 September 2026")
date.alignment = WD_ALIGN_PARAGRAPH.CENTER

intro = doc.add_paragraph()
intro.add_run(
    "This brief accompanies the 4 September 2026 single-VM recommendation. It proposes a managed-service "
    "design for the same application and states, in Section 13, what to change in the VM design if company "
    "policy requires infrastructure-as-a-service. Every sizing decision below is derived from the current "
    "application source, not from a generic template."
).italic = True

# ---------------------------------------------------------------- 1
doc.add_heading("1. Decision summary", level=1)
doc.add_paragraph(
    "Host the mobile API on Azure App Service (Linux, Premium v3 P1v3, two instances), with Azure Database "
    "for PostgreSQL Flexible Server, Azure Cache for Redis, and Azure Files for the protected journal and "
    "white-paper PDFs. Keep Cloudflare as the public edge and web application firewall. Give the application "
    "a fixed outbound address through a NAT Gateway. The public WordPress website remains on Kinsta."
)
doc.add_paragraph(
    "This costs approximately the same as the previously proposed Standard_D8as_v6 virtual machine, but adds "
    "high availability, managed patching, managed backups, and horizontal autoscale, and removes IIS, ARR and "
    "Windows service wrappers from the operational surface."
)
doc.add_paragraph(
    "Three application changes are prerequisites for running more than one instance. They are listed in "
    "Section 7 and Section 14 and must be completed before cutover."
)

# ---------------------------------------------------------------- 2
doc.add_heading("2. Basis of assessment", level=1)
doc.add_paragraph(
    "The following characteristics were read from the application source and drive every recommendation in "
    "this document."
)
table(doc, ["Component", "Current behaviour in the code", "Consequence for hosting"], [
    ["API runtime",
     "Node.js 20+, Express 5, TypeScript, ES modules; 15 route groups under /v1",
     "Runs unchanged on Linux App Service; no Windows dependency exists in the code"],
    ["Database",
     "PostgreSQL through the pg driver, pool limited to 10 connections per process; currently on localhost",
     "Can move to a managed server without code change; connection totals must be planned per instance"],
    ["Content cache",
     "In-process JavaScript Map with a 900-second TTL, holding all WordPress-sourced news, podcast and video listings",
     "Not shared between instances; two instances would double outbound load on a source that already blocks us"],
    ["Rate limiting",
     "express-rate-limit with in-memory counters, 120 requests per minute per IP",
     "Per-instance counters; the effective limit multiplies by the instance count unless a shared store is used"],
    ["Protected documents",
     "Journal and white-paper PDFs read from a local directory and streamed, including HTTP range requests",
     "Requires storage reachable from every instance; range streaming must continue to work"],
    ["Edge caching",
     "Public read endpoints already emit Cache-Control: public, max-age; premium and PDF routes emit private, no-store",
     "The application is already written for a shared edge cache; the edge must be configured to honour it"],
    ["Outbound dependency",
     "WordPress REST API on ibsintelligence.com, which returns an empty 403 to non-browser TLS fingerprints",
     "The platform must present one stable outbound IP address that Cloudflare can allowlist"],
    ["Integrations",
     "Firebase Admin (authentication and push), Google Play and Apple App Store server APIs, Apple server notifications",
     "The Apple signed payload must reach the application as an unmodified raw body"],
])

# ---------------------------------------------------------------- 3
doc.add_heading("3. Business context and capacity target", level=1)
bullets(doc, [
    "The target is approximately 100,000 registered mobile users, not 100,000 simultaneous users.",
    "The established website audience means the mobile launch may produce short, sharp traffic spikes when promoted.",
    "Public feeds (news, galaxy, awards, events, advertisements) are cacheable and are expected to be served largely from the Cloudflare edge.",
    "Only authenticated, metered and document-delivery requests must reach Azure on every call.",
    "Planning assumption: 70-85% edge cache hit ratio on public reads, leaving an estimated 50-100 requests per second at the origin during a launch spike.",
    "The website itself stays on Kinsta. This platform serves the mobile backend, its database and its protected documents only.",
])

# ---------------------------------------------------------------- 4
doc.add_heading("4. Recommended platform components", level=1)
table(doc, ["Layer", "Azure service and size", "Quantity / notes"], [
    ["API compute", "App Service, Linux, Premium v3 P1v3 (2 vCPU, 8 GB RAM)",
     "2 instances at launch; autoscale 2 to 5"],
    ["Database", "Azure Database for PostgreSQL Flexible Server, Standard_D2ds_v5 (2 vCPU, 8 GB RAM)",
     "256 GB Premium SSD, zone-redundant high availability"],
    ["Cache", "Azure Cache for Redis, Standard C1 (1 GB)",
     "Standard tier, not Basic; Basic has no replica"],
    ["Document storage", "Azure Files, Premium file share, 200 GB",
     "Mounted into App Service as a path"],
    ["Outbound address", "NAT Gateway with a Standard static public IPv4",
     "Mandatory; see Section 9"],
    ["Secrets", "Azure Key Vault, standard tier",
     "Accessed by managed identity"],
    ["Public edge and WAF", "Cloudflare (already in place)",
     "No Azure Front Door; see Section 9"],
    ["Monitoring", "Application Insights and Log Analytics workspace",
     "30-day retention initially"],
    ["Backup", "Flexible Server automated backups; Azure Backup for the file share",
     "See Section 11"],
])
doc.add_paragraph(
    "Region: Central India, deployed across availability zones. Cloudflare serves international readers from "
    "its own edge, so proximity between the application tier and the database matters more than proximity "
    "between the application and the end user. Confirm against company policy and regional service availability."
)

# ---------------------------------------------------------------- 5
doc.add_heading("5. App Service configuration", level=1)
table(doc, ["Setting", "Required value"], [
    ["Plan", "Premium v3 P1v3, Linux"],
    ["Runtime", "Node 22 LTS"],
    ["Instances", "2 minimum, 5 maximum"],
    ["Autoscale rule", "Scale out when CPU exceeds 65% for 10 minutes; scale in below 35% for 20 minutes"],
    ["Health check path", "/health"],
    ["Always On", "Enabled"],
    ["HTTPS only", "Enabled; minimum TLS 1.2"],
    ["HTTP version", "HTTP/2 enabled"],
    ["Deployment slot", "One staging slot, swapped after health verification"],
    ["Access restrictions", "Allow Cloudflare published IP ranges only; deny all other inbound"],
    ["VNet integration", "Enabled, routed through the NAT Gateway subnet"],
    ["Application settings", "NODE_ENV=production, LOG_LEVEL=info, all secrets as Key Vault references"],
])
bullets(doc, [
    "Deploy the compiled output (npm run build) and start with node dist/server.js. The application already handles SIGTERM and closes the database pool, so slot swaps and scale-in are graceful.",
    "Do not enable any request body buffering or rewriting on the /v1/webhooks path. The Apple signed payload is verified over the exact bytes received.",
    "The application sets trust proxy to one hop. Confirm after cutover that rate limiting and logs record the real client IP address rather than an edge address.",
])

# ---------------------------------------------------------------- 6
doc.add_heading("6. Database configuration", level=1)
table(doc, ["Setting", "Required value"], [
    ["Service", "Azure Database for PostgreSQL Flexible Server"],
    ["Compute", "Standard_D2ds_v5, 2 vCPU, 8 GB RAM"],
    ["Storage", "256 GB Premium SSD, autogrow enabled"],
    ["High availability", "Zone-redundant"],
    ["Version", "PostgreSQL 16 or 17 (a version supported by the pg driver in use)"],
    ["Connection pooling", "Built-in PgBouncer enabled, transaction mode"],
    ["max_connections", "100"],
    ["Extensions", "pg_stat_statements enabled"],
    ["log_min_duration_statement", "500 ms"],
    ["Networking", "Private endpoint or VNet integration only; no public access"],
    ["Backups", "Automated, 14-day point-in-time retention, geo-redundant where policy permits"],
])
bullets(doc, [
    "The application pool is capped at 10 connections per process. With two to five instances that is 20 to 50 direct connections; PgBouncer keeps the server-side total flat as instances scale.",
    "Connect the application through the PgBouncer port and set DATABASE_SSL=true. Managed PostgreSQL requires TLS.",
    "Create the database with a single owning role. See Section 14, item 1.",
])

# ---------------------------------------------------------------- 7
doc.add_heading("7. Caching design", level=1)
doc.add_paragraph(
    "Caching is deliberately layered. The first layer already exists in the application; the second is the "
    "change that unlocks horizontal scale."
)
table(doc, ["Layer", "Mechanism", "What it protects"], [
    ["1. Edge", "Cloudflare, honouring the Cache-Control headers the API already emits on public read endpoints",
     "Removes the majority of public feed traffic before it reaches Azure. Largest single performance gain and no additional cost."],
    ["2. Shared application cache", "Azure Cache for Redis, replacing the current in-process Map in the WordPress service, and backing the rate limiter",
     "Keeps outbound WordPress calls constant regardless of instance count, and keeps the published rate limit accurate across instances."],
    ["3. Database", "PgBouncer transaction pooling and pg_stat_statements-driven index tuning",
     "Keeps connection counts and query latency stable under autoscale."],
])
doc.add_heading("Required application changes before scale-out", level=2)
numbered(doc, [
    "Move the cache helper in the WordPress service from the in-process Map to Redis, preserving the existing key names and TTL behaviour.",
    "Configure express-rate-limit with a Redis store so the 120-requests-per-minute limit is enforced across all instances.",
    "Point the journal and white-paper storage directories at the mounted Azure Files path.",
])
doc.add_paragraph(
    "Until these three are complete, the platform must run on a single instance. They are small, contained "
    "changes and should be scheduled before, not after, the migration."
)

# ---------------------------------------------------------------- 8
doc.add_heading("8. Protected document storage", level=1)
bullets(doc, [
    "Provision an Azure Files Premium share of 200 GB and mount it into App Service; set JOURNAL_STORAGE_DIR and WHITEPAPER_STORAGE_DIR to directories on that mount.",
    "This requires no change to the document-serving code. Signed-link validation, expiry and HTTP range streaming continue to work as written.",
    "The share must not be publicly reachable. Documents are only ever served through the API, which checks the signed token and the entitlement of the caller first.",
    "Confirm the present and projected size of the PDF collection before finalising 200 GB; the share can be grown later.",
    "Longer term, moving documents to Blob Storage with short-lived user-delegation SAS links would remove PDF transfer from the application tier entirely. That is an application change and is not required for this migration.",
])

# ---------------------------------------------------------------- 9
doc.add_heading("9. Networking, egress and edge", level=1)
table(doc, ["Requirement", "Configuration"], [
    ["Public entry point", "Cloudflare proxied DNS in front of App Service"],
    ["Origin lock-down", "App Service access restrictions permit Cloudflare IP ranges only"],
    ["Outbound address", "VNet integration routed through a NAT Gateway with one Standard static public IPv4"],
    ["Database exposure", "Private endpoint only; no public endpoint"],
    ["Redis exposure", "Private endpoint or firewall restricted to the application subnet"],
    ["File share exposure", "Private endpoint; no public access"],
    ["Administration", "Azure portal and CLI with multi-factor authentication; no RDP or SSH surface to manage"],
])
doc.add_paragraph(
    "The fixed outbound address is not optional. The WordPress REST API behind Cloudflare returns an empty 403 "
    "to the TLS fingerprint of this application, and the agreed workaround depends on allowlisting the IP "
    "address of the server. If the outbound IP changes at cutover without the Cloudflare rule being updated "
    "first, the news, podcast and video endpoints will return empty results."
)
doc.add_paragraph(
    "Do not place Azure Front Door or Application Gateway in front of Cloudflare. Two proxy layers break the "
    "single-hop client IP assumption the application makes and add cost without benefit here."
)

# ---------------------------------------------------------------- 10
doc.add_heading("10. Secrets and identity", level=1)
bullets(doc, [
    "Store every secret in Azure Key Vault and reference it from App Service application settings. Grant access by system-assigned managed identity, not by connection string.",
    "Secrets in scope: the database connection string, the Firebase service-account credentials, the Google Play service-account private key, the Apple verification credentials, and the journal and white-paper signing secrets.",
    "The Google Play service-account private key is currently held in plain text in the environment file on the server. Rotate that key in Google Cloud as part of this migration and load the replacement from Key Vault. Do not copy the existing file to Azure.",
    "The journal and white-paper signing secrets must differ from each other and from any value used in development, so rotating one does not invalidate the outstanding links of the other.",
    "Record secret expiry dates and set Key Vault expiry alerts.",
])

# ---------------------------------------------------------------- 11
doc.add_heading("11. Monitoring, alerting and backup", level=1)
table(doc, ["Signal", "Initial alert threshold"], [
    ["API p95 response time", "Above 500 ms for 10 minutes"],
    ["HTTP 5xx rate", "Above 1% of requests"],
    ["App Service CPU", "Above 75% for 10 minutes"],
    ["App Service memory", "Above 80%"],
    ["Instance count", "Alert when autoscale reaches maximum"],
    ["PostgreSQL connections", "Above 70"],
    ["PostgreSQL CPU and storage", "Above 75%"],
    ["Redis evictions", "Any sustained eviction, and cache hit ratio below 80%"],
    ["Health endpoint", "Any failure of /health"],
    ["Outbound WordPress failures", "Any sustained 403 or timeout rate, which indicates the allowlist has lapsed"],
    ["Backups", "Any failed or missed backup"],
    ["TLS certificate", "Alert well before expiry"],
])
bullets(doc, [
    "PostgreSQL Flexible Server automated backups with 14-day point-in-time restore; take an additional scheduled logical dump for off-platform retention.",
    "Azure Backup for the Azure Files share holding the documents.",
    "Application code is redeployable from source control and does not require separate backup.",
    "Perform and document a full restore test at least quarterly, including one document-share restore.",
])

# ---------------------------------------------------------------- 12
doc.add_heading("12. Indicative monthly cost", level=1)
doc.add_paragraph(
    "Approximate list prices for Central India, pay-as-you-go, in US dollars. These are planning figures only "
    "and must be confirmed in the Azure pricing calculator against the agreement and discounts of the "
    "organisation."
)
table(doc, ["Component", "Indicative monthly cost (USD)"], [
    ["App Service, 2 x P1v3 Linux", "250"],
    ["PostgreSQL Flexible Server D2ds_v5 with zone-redundant HA and 256 GB", "260"],
    ["Azure Cache for Redis Standard C1", "100"],
    ["Azure Files Premium, 200 GB", "35"],
    ["NAT Gateway and static public IP", "45"],
    ["Key Vault, Application Insights, backups", "40"],
    ["Estimated total", "approximately 730"],
])
bullets(doc, [
    "A reduced launch configuration - one P1v3 instance and PostgreSQL without zone-redundant high availability - lands near 450 per month and can be raised without redeployment.",
    "One-year reserved instances reduce compute cost by roughly a third once the sizing has been confirmed by real traffic.",
    "Outbound data transfer is billed separately and is driven mainly by PDF downloads. Measure it in the first month before committing to a figure.",
])

# ---------------------------------------------------------------- 13
doc.add_heading("13. If policy requires virtual machines", level=1)
doc.add_paragraph(
    "The 4 September brief specifies one Standard_D8as_v6 Windows Server virtual machine hosting IIS, Node.js, "
    "PostgreSQL and the documents together. It is a sound lift-and-shift and remains a valid option. Two "
    "characteristics should be weighed before approving it."
)
bullets(doc, [
    "It provides no high availability. A reboot, a failed Windows update or a disk problem is a full outage of the mobile backend.",
    "PostgreSQL, the Node.js workers and PDF streaming compete for the same memory and I/O on one machine, which makes capacity problems harder to attribute.",
])
doc.add_paragraph("If the virtual-machine route is chosen, the following amendments are recommended:")
numbered(doc, [
    "Move PostgreSQL to Azure Database for PostgreSQL Flexible Server regardless of where the API runs. This single change removes most of the combined-host failure modes.",
    "With the database moved, reduce the VM to Standard_D4as_v6 (4 vCPU, 16 GB). This workload is I/O and network bound rather than CPU bound.",
    "Keep the separate managed disk for documents, and keep the strict network rules, backup vault and monitoring already specified.",
    "Add Azure Cache for Redis and the shared-storage changes from Section 7 before introducing a second VM behind a load balancer.",
])
doc.add_paragraph(
    "The managed-service design in this document costs approximately the same as the original 8-vCPU VM "
    "specification while providing high availability and autoscale."
)

# ---------------------------------------------------------------- 14
doc.add_heading("14. Blockers to clear before cutover", level=1)
numbered(doc, [
    "Database migrations 012 and 013 currently abort on table ownership, so migration 014 has never run. The new server must be created with a single owning role and the migration ledger verified end to end. This will surface during migration, not after it.",
    "Production secrets are held in plain text in an environment file on a mapped network drive, including a Google Play service-account private key. Rotate that key and move all secrets to Key Vault as part of this work.",
    "The Cloudflare WAF allowlist must be updated to the new outbound IP address before DNS cutover, or the WordPress-backed endpoints will return empty results.",
    "No gateway, firewall rule or proxy may modify or buffer the body of requests to /v1/webhooks. The Apple signature is verified over the exact bytes received.",
    "Confirm after cutover that the application sees the real client IP address, so rate limiting is applied per user rather than per edge node.",
    "The Redis-backed cache and rate limiter, and the shared document mount, must be in place before the platform runs more than one instance.",
])

# ---------------------------------------------------------------- 15
doc.add_heading("15. Migration sequence", level=1)
numbered(doc, [
    "Create the resource group, virtual network, subnets, NAT Gateway and static public IP.",
    "Provision PostgreSQL Flexible Server, Azure Cache for Redis, the Azure Files share and Key Vault, all on private networking.",
    "Create the App Service plan, the application and its staging slot; enable VNet integration, managed identity and Key Vault references.",
    "Complete the three application changes in Section 7 and verify them against a staging deployment.",
    "Create the database with a single owning role and run every migration in order; verify the migration ledger.",
    "Copy journal and white-paper PDFs to the file share, preserving filenames exactly, and verify a signed link end to end.",
    "Rotate the Google Play service-account key and load all secrets into Key Vault.",
    "Request the Cloudflare allowlist update for the new outbound IP address and confirm the WordPress-backed endpoints return data.",
    "Test Firebase sign-in and profile synchronisation, entitlement metering, Google Play and Apple purchase verification, push notifications, PDF range requests and every public endpoint.",
    "Complete a staged load test at the expected launch-spike rate and record the results.",
    "Test backup and complete at least one restore before cutover.",
    "Reduce DNS time-to-live, cut over through Cloudflare, monitor errors and latency, and retain a documented rollback path to the existing server.",
])

# ---------------------------------------------------------------- 16
doc.add_heading("16. Acceptance criteria", level=1)
bullets(doc, [
    "The application is reachable only through Cloudflare; the origin rejects direct requests.",
    "The database, cache and file share have no public network exposure.",
    "The health endpoint returns HTTP 200 with a database status of ok from every instance.",
    "Firebase sign-in and profile synchronisation succeed from the production mobile application.",
    "Journal and white-paper links are refused for users without entitlement, expire on schedule, and never appear in application logs.",
    "Google Play and Apple purchase verification and server notifications are processed correctly.",
    "WordPress-backed news, podcast and video endpoints return data from the new outbound IP address.",
    "The rate limit is enforced consistently while running on more than one instance.",
    "Autoscale adds and removes an instance under test without dropped requests.",
    "A backup completes and a restore test succeeds.",
    "Alerts reach the responsible IT contacts.",
])

# ---------------------------------------------------------------- 17
doc.add_heading("17. Decisions required from IT", level=1)
bullets(doc, [
    "Managed services as recommended, or the amended virtual-machine design in Section 13.",
    "Region: Central India as recommended, or another region on policy grounds.",
    "Whether zone-redundant high availability for the database is approved at launch or deferred.",
    "Present and projected size of the PDF collection, which sets the file share capacity.",
    "Recovery point and recovery time objectives, which set backup retention.",
    "Confirmation that Cloudflare remains the edge and WAF, and who owns the allowlist change.",
    "Approval and ownership of Key Vault, and the schedule for rotating the exposed Google Play key.",
    "Reserved-instance commitment now, or after the first three months of measured traffic.",
])

# ---------------------------------------------------------------- 18
doc.add_heading("18. Final recommendation", level=1)
doc.add_paragraph(
    "Approve the managed-service platform: App Service Premium v3 P1v3 with two Linux instances, Azure "
    "Database for PostgreSQL Flexible Server D2ds_v5 with zone-redundant high availability, Azure Cache for "
    "Redis Standard C1, a 200 GB Azure Files Premium share for protected documents, a NAT Gateway with a static "
    "outbound IP address, Key Vault for secrets, and Application Insights for monitoring, all behind the "
    "existing Cloudflare edge in an Indian Azure region."
)
doc.add_paragraph(
    "Schedule the three application changes in Section 7 ahead of the migration, clear the six blockers in "
    "Section 14, and reassess sizing after three months of measured mobile traffic."
)

doc.save(OUTPUT)
print(f"Wrote {OUTPUT}")
