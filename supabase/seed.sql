-- OPTIONAL DEMO DATA ONLY. Use only in a disposable development Supabase project.
-- Test owner passwords are intentionally unusable; they cannot sign in.
-- This seed creates no sample guest orders and contains no real student data.

BEGIN;

INSERT INTO bitehub_app.users
  (name, email, password_hash, password_salt, role, school_id)
VALUES
  ('BiteHub Demo Owner One', 'demo.owner.one@example.invalid', repeat('0', 64), repeat('0', 32), 'owner', 'pns'),
  ('BiteHub Demo Owner Two', 'demo.owner.two@example.invalid', repeat('0', 64), repeat('0', 32), 'owner', 'pns')
ON CONFLICT DO NOTHING;

INSERT INTO bitehub_app.stalls (owner_id, name, description, status, opens_at, closes_at)
SELECT u.id, seed.stall_name, seed.description, 'approved', '07:00', '15:30'
FROM (VALUES
  ('demo.owner.one@example.invalid', '(DEMO) Merienda Booth', 'Synthetic menu for testing BiteHub browsing and stock states.'),
  ('demo.owner.two@example.invalid', '(DEMO) Bake & Sip', 'Synthetic menu for testing BiteHub browsing and stock states.')
) AS seed(owner_email, stall_name, description)
JOIN bitehub_app.users u ON u.email = seed.owner_email
ON CONFLICT (owner_id) DO NOTHING;

INSERT INTO bitehub_app.products
  (stall_id, name, description, ingredients, category, price_cents, emoji,
   available, stock_count, dietary_tags, allergen_tags)
SELECT s.id, seed.product_name, seed.description, seed.ingredients, seed.category,
       seed.price_cents, seed.emoji, seed.available, seed.stock_count, '[]', seed.allergen_tags
FROM (VALUES
  ('(DEMO) Merienda Booth', 'TEST Fish Balls', 'Demo snack item.', 'Fish, flour, seasoning', 'Snacks', 2000, '🍢', true, 12, '["fish","wheat"]'),
  ('(DEMO) Merienda Booth', 'TEST Chicken Rice Bowl', 'Demo filling meal.', 'Chicken, rice, vegetables', 'Meals', 6500, '🍚', true, 8, '[]'),
  ('(DEMO) Merienda Booth', 'TEST Calamansi Cooler', 'Demo cold drink.', 'Calamansi, water, sugar', 'Drinks', 2500, '🍹', true, 16, '[]'),
  ('(DEMO) Bake & Sip', 'TEST Cheese Pandesal', 'Demo baked snack.', 'Bread, cheese, milk', 'Snacks', 1800, '🥖', true, 10, '["wheat","milk"]'),
  ('(DEMO) Bake & Sip', 'TEST Pancit Canton Cup', 'Demo quick meal.', 'Noodles, vegetables, soy', 'Meals', 4500, '🍜', true, 6, '["wheat","soy"]'),
  ('(DEMO) Bake & Sip', 'TEST Iced Chocolate', 'Demo sold-out drink state.', 'Cocoa, milk, ice', 'Drinks', 3000, '🥤', false, 0, '["milk"]')
) AS seed(stall_name, product_name, description, ingredients, category, price_cents, emoji, available, stock_count, allergen_tags)
JOIN bitehub_app.stalls s ON s.name = seed.stall_name
WHERE NOT EXISTS (
  SELECT 1 FROM bitehub_app.products p
  WHERE p.stall_id = s.id AND p.name = seed.product_name
);

COMMIT;
