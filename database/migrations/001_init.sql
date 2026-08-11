-- Outreach Consent Connector — connector-owned state only.
-- The consent ledger, identity, and review queues live in YOUR consent
-- platform. These tables make the connector restartable, idempotent, and
-- version-safe.

BEGIN;

CREATE TABLE sync_checkpoint (
    tenant_id    text        NOT NULL,
    connector_id text        NOT NULL,
    job_type     text        NOT NULL,   -- HISTORICAL_IMPORT | INCREMENTAL_POLL
    cursor       text,                   -- JSON:API next link ('DONE' when import completes)
    watermark    timestamptz,            -- max observed prospect updatedAt
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, connector_id, job_type)
);

CREATE TABLE destination_applied_version (
    tenant_id       text   NOT NULL,
    org_id          text   NOT NULL,     -- Outreach org
    party_id        text   NOT NULL,
    purpose_code    text   NOT NULL,
    channel         text   NOT NULL,     -- EMAIL | CALL | SMS
    applied_version bigint NOT NULL,
    correlation_id  text   NOT NULL,
    PRIMARY KEY (tenant_id, org_id, party_id, purpose_code, channel)
);

CREATE TABLE delivery_receipt (
    delivery_id              text        PRIMARY KEY,
    change_id                text        NOT NULL,
    destination_system       text        NOT NULL,
    destination_org_id       text        NOT NULL,
    destination_prospect_id  text        NOT NULL,
    consent_version          bigint      NOT NULL,
    status                   text        NOT NULL,
    requires_alt_enforcement boolean     NOT NULL DEFAULT false,
    attempt_count            int         NOT NULL DEFAULT 0,
    delivered_at             timestamptz,
    detail                   text,
    UNIQUE (destination_system, destination_org_id, change_id)
);

COMMIT;
