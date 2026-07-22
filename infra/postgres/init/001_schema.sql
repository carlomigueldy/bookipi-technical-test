-- Flash sale schema. Applied by postgres docker-entrypoint-initdb.d on first boot.
-- Phase 0: schema only. No seed rows here (seeding lands in Phase 1).

BEGIN;

CREATE TYPE order_status AS ENUM ('reserved', 'persisted', 'compensated');

CREATE TABLE sales (
  id          text        PRIMARY KEY,
  name        text        NOT NULL,
  total_stock integer     NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_total_stock_nonneg CHECK (total_stock >= 0),
  CONSTRAINT sales_window_valid       CHECK (ends_at > starts_at)
);

CREATE TABLE orders (
  id           uuid         PRIMARY KEY,
  user_id      text         NOT NULL,
  sale_id      text         NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
  status       order_status NOT NULL,
  created_at   timestamptz  NOT NULL,
  persisted_at timestamptz,
  request_id   text         NOT NULL,
  CONSTRAINT orders_user_id_len CHECK (char_length(user_id) BETWEEN 3 AND 64),
  CONSTRAINT orders_request_id_len CHECK (char_length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT orders_persisted_at_state CHECK (
    (status = 'persisted' AND persisted_at IS NOT NULL) OR
    (status IN ('reserved', 'compensated') AND persisted_at IS NULL)
  )
);

-- I2 (one confirmed order per user) — the second, independent enforcement point.
-- Deliberately on user_id ALONE, not (sale_id, user_id): the brief scopes this system
-- to a single limited-stock product, and a global uniqueness guarantee is the stronger
-- statement. Revisit only if multi-sale support is ever added.
CREATE UNIQUE INDEX orders_user_id_uniq ON orders (user_id);

CREATE INDEX orders_sale_id_status_idx ON orders (sale_id, status);
CREATE INDEX orders_created_at_idx     ON orders (created_at DESC);

COMMIT;
