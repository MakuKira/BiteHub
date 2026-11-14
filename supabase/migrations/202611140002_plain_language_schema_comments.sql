-- Human-readable descriptions for BiteHub's private PostgreSQL schema.
-- Metadata only: no row data, grants, RLS, columns, or table names are changed.
-- Missing optional feature tables/columns are skipped safely.

BEGIN;

DO $bitehub_comments$
DECLARE
  item record;
BEGIN
  IF to_regnamespace('bitehub_app') IS NULL THEN
    RAISE NOTICE 'bitehub_app schema is not installed here; no descriptions were added.';
    RETURN;
  END IF;

  EXECUTE 'COMMENT ON SCHEMA bitehub_app IS ''Private BiteHub application data. Access it through the trusted BiteHub server, not directly from browser or mobile clients.''';

  FOR item IN
    SELECT * FROM (VALUES
      ('schools', 'PNS school directory and school locations used for campus delivery.'),
      ('users', 'Registered accounts for stall owners, school admins, runners, and legacy buyers. Guest customers use guest_sessions instead.'),
      ('sessions', 'Active signed-in sessions. Stores a hash of the session cookie token and its expiry, not the raw cookie.'),
      ('stalls', 'A stall profile owned by one registered owner account, including approval state, open hours, preparation time, and pickup point.'),
      ('products', 'Food catalog items for stalls, including price, stock, availability, ingredients, allergens, photos, featured time, and optional archive time.'),
      ('reach_views', 'Daily privacy-preserving counts of stall and product views. viewer_key is an opaque deduplication key, not a display name.'),
      ('settings', 'Server-side key/value controls such as campus ordering pause and stall registration mode.'),
      ('orders', 'One checkout record for one stall. Links to a registered buyer or guest session, fulfillment, status, totals, and handoff details.'),
      ('order_items', 'Food lines saved at checkout. Name and price are snapshots so receipts remain readable if a product changes later.'),
      ('feedback', 'Optional review attached to a completed order. buyer_id is nullable so verified guests can review.'),
      ('delivery_positions', 'Latest courier latitude/longitude for an active delivery order. Treat coordinates as sensitive location data.'),
      ('push_subscriptions', 'Private browser/device push subscription data for signed-in accounts.'),
      ('school_requests', 'Legacy school request records retained for compatibility; not used in the current main BiteHub workflow.'),
      ('email_auth_tokens', 'Temporary hashed tokens for email verification or password reset; tokens expire and are not passwords.'),
      ('guest_sessions', 'Temporary anonymous browsing/order sessions with a generated ID, display name, hashed cookie token, and expiry.'),
      ('order_messages', 'Private chat messages scoped to a single order between a guest or buyer and that stall owner.'),
      ('guest_push_subscriptions', 'Private push subscription data linked to temporary guest sessions.'),
      ('notifications', 'In-app notification inbox entries, each belonging to either one registered user or one guest session.'),
      ('weekly_menu_slots', 'A repeating stall menu plan connecting one food item to a weekday and school-break service period.'),
      ('admin_passkeys', 'School-admin WebAuthn credentials. Stores credential public-key data; it does not store a passkey private key.'),
      ('webauthn_challenges', 'Short-lived one-use challenges used while registering or verifying a school-admin passkey.'),
      ('admin_activity', 'Audit history of school-admin actions, including the snapshots needed to restore eligible removed stalls or products.')
    ) AS descriptions(table_name, description)
  LOOP
    IF to_regclass(format('%I.%I', 'bitehub_app', item.table_name)) IS NOT NULL THEN
      EXECUTE format('COMMENT ON TABLE %I.%I IS %L', 'bitehub_app', item.table_name, item.description);
    END IF;
  END LOOP;

  FOR item IN
    SELECT * FROM (VALUES
      ('schools','id','Stable school code used by accounts, such as pns.'),
      ('schools','name','Official school display name.'),
      ('schools','school_type','School level or institution type.'),
      ('schools','region','Administrative region for the school.'),
      ('schools','province','Province where the school is located.'),
      ('schools','city','City or municipality where the school is located.'),
      ('schools','latitude','School map latitude in decimal degrees.'),
      ('schools','longitude','School map longitude in decimal degrees.'),
      ('schools','delivery_radius_m','Maximum configured delivery distance in metres.'),
      ('schools','created_at','When this school record was added.'),

      ('users','id','Unique registered-account ID.'),
      ('users','name','Account holder display name.'),
      ('users','email','Sign-in email address, normalized by the server.'),
      ('users','password_hash','Salted password verifier. This is not the plaintext password.'),
      ('users','password_salt','Random salt used with password_hash.'),
      ('users','role','Account permission category, such as owner, admin, or runner.'),
      ('users','school_id','School code linked to this account.'),
      ('users','grade_section','Legacy account-level grade/section. Current guest order details are stored on orders.'),
      ('users','profile_photo_data','Profile photo bytes; private personal image data.'),
      ('users','profile_photo_type','MIME type for the profile photo, such as image/jpeg.'),
      ('users','profile_photo_version','Incremented when the profile photo changes, for cache refresh.'),
      ('users','created_at','When the account was created.'),
      ('users','deleted_at','Soft-delete timestamp. NULL means the account is active.'),
      ('users','email_verified','Whether the backend considers this account email verified.'),

      ('sessions','token_hash','Hash of the private session cookie token; the raw token is not stored.'),
      ('sessions','user_id','Registered account that owns this session.'),
      ('sessions','expires_at','Session expiry as Unix time in seconds.'),

      ('stalls','id','Unique stall profile ID.'),
      ('stalls','owner_id','Registered user account that owns this stall.'),
      ('stalls','name','Public stall name shown in BiteHub.'),
      ('stalls','description','Short stall description shown to customers.'),
      ('stalls','status','Review/sales state: pending, approved, or paused.'),
      ('stalls','opens_at','Daily opening time in local school time.'),
      ('stalls','closes_at','Daily closing time in local school time.'),
      ('stalls','prep_minutes','Estimated food preparation time in minutes.'),
      ('stalls','pickup_slot_capacity','Maximum orders allowed in one pickup time slot.'),
      ('stalls','pickup_lat','Stall pickup-point latitude in decimal degrees.'),
      ('stalls','pickup_lon','Stall pickup-point longitude in decimal degrees.'),
      ('stalls','logo_data','Stall logo image bytes.'),
      ('stalls','logo_type','MIME type for the stall logo.'),

      ('products','id','Unique food-item ID.'),
      ('products','stall_id','Stall that sells this food item.'),
      ('products','name','Food name shown in the catalog and saved to order lines.'),
      ('products','description','Customer-facing food description.'),
      ('products','ingredients','Ingredient text supplied by the stall.'),
      ('products','category','Menu category such as Meals, Snacks, or Drinks.'),
      ('products','price_cents','Price as an integer number of cents; 2500 means ₱25.00.'),
      ('products','emoji','Fallback food illustration when no product photo is set.'),
      ('products','available','Whether the stall currently offers this food for ordering.'),
      ('products','stock_count','Remaining stock; NULL means stock is not tracked.'),
      ('products','dietary_tags','JSON text list of dietary labels.'),
      ('products','allergen_tags','JSON text list of known allergen labels.'),
      ('products','photo_data','Food photo bytes.'),
      ('products','photo_type','MIME type for the food photo.'),
      ('products','created_at','When the food item was first added.'),
      ('products','featured_until','Time when catalog featuring ends.'),
      ('products','deleted_at','Admin archive timestamp. NULL means the item is not archived.'),

      ('orders','id','Unique order number used in the app.'),
      ('orders','buyer_id','Registered buyer account, if this was an account order; NULL for guests.'),
      ('orders','guest_session_id','Temporary guest session, if this was a guest order.'),
      ('orders','stall_id','Stall that receives and prepares this order.'),
      ('orders','runner_id','Registered runner assigned to the delivery, if applicable.'),
      ('orders','fulfillment','Whether the order is campus pickup or delivery.'),
      ('orders','status','Current order state, from placed through completed or declined.'),
      ('orders','total_cents','Order total as integer cents.'),
      ('orders','buyer_note','Optional note from the customer.'),
      ('orders','created_at','When checkout was submitted.'),
      ('orders','updated_at','When the order record last changed.'),
      ('orders','estimated_ready_at','Estimated food-ready time.'),
      ('orders','pickup_at','Scheduled campus pickup time, when selected.'),
      ('orders','delivery_lat','Customer delivery latitude; sensitive location data.'),
      ('orders','delivery_lon','Customer delivery longitude; sensitive location data.'),
      ('orders','runner_name','Display name for the runner assigned to this order.'),
      ('orders','runner_tracking_token_hash','Hash of the private runner-tracking share token.'),
      ('orders','runner_tracking_expires_at','Expiry for the runner-tracking share link.'),
      ('orders','pickup_offer_status','State of a runner pickup offer.'),
      ('orders','guest_name','Guest display name copied onto the order.'),
      ('orders','guest_school_role','Guest school role supplied at checkout.'),
      ('orders','guest_grade','Guest grade supplied at checkout.'),
      ('orders','guest_section','Guest section supplied at checkout.'),
      ('orders','guest_access_token_hash','Hash used to authorize private guest access to this order.'),
      ('orders','guest_pickup_code','Pickup handoff code for this order.'),
      ('orders','buyer_cancelled','True when the buyer cancelled before stall acceptance.'),

      ('order_items','id','Unique saved order-line ID.'),
      ('order_items','order_id','Order this food line belongs to.'),
      ('order_items','product_id','Current catalog item reference; may be NULL if that item was hard-deleted.'),
      ('order_items','name','Food name snapshot taken at checkout.'),
      ('order_items','price_cents','Unit price snapshot at checkout, in cents.'),
      ('order_items','quantity','Number of units purchased.'),
      ('order_items','emoji','Food illustration snapshot for the receipt.'),

      ('feedback','order_id','Order being reviewed; one feedback row per order.'),
      ('feedback','buyer_id','Registered reviewer when present; NULL for a verified guest review.'),
      ('feedback','rating','Customer score from 1 to 5.'),
      ('feedback','comment','Optional written review.'),
      ('feedback','created_at','When the review was submitted.'),

      ('delivery_positions','order_id','Delivery order whose latest courier location is stored.'),
      ('delivery_positions','latitude','Latest courier latitude in decimal degrees.'),
      ('delivery_positions','longitude','Latest courier longitude in decimal degrees.'),
      ('delivery_positions','accuracy','GPS accuracy estimate in metres, if supplied.'),
      ('delivery_positions','heading','Courier travel heading in degrees, if supplied.'),
      ('delivery_positions','updated_at','When this location was last refreshed.'),

      ('push_subscriptions','id','Unique device-subscription row ID.'),
      ('push_subscriptions','user_id','Registered account receiving notifications on this device.'),
      ('push_subscriptions','endpoint','Private browser push endpoint URL.'),
      ('push_subscriptions','subscription_json','Serialized push endpoint and encryption key material; keep private.'),
      ('push_subscriptions','created_at','When this device subscription was saved.'),
      ('push_subscriptions','updated_at','When this device subscription was last refreshed.'),

      ('school_requests','id','Unique legacy school-request ID.'),
      ('school_requests','school_name','Requested school display name.'),
      ('school_requests','school_type','Requested school level or institution type.'),
      ('school_requests','region','Requested school region.'),
      ('school_requests','province','Requested school province.'),
      ('school_requests','city','Requested school city or municipality.'),
      ('school_requests','zip','Requested postal code.'),

      ('email_auth_tokens','token_hash','Hash of a one-time verification or reset token; raw token is not stored.'),
      ('email_auth_tokens','user_id','Account for which the one-time token was issued.'),
      ('email_auth_tokens','purpose','Whether the token is for email verification or password reset.'),
      ('email_auth_tokens','expires_at','Token expiry as Unix time in seconds.'),
      ('email_auth_tokens','created_at','When the token was issued.'),

      ('guest_sessions','id','Generated database ID for this anonymous guest session.'),
      ('guest_sessions','guest_name','Name the guest chose for browsing and order updates.'),
      ('guest_sessions','token_hash','Hash of the private guest cookie token; raw token is not stored.'),
      ('guest_sessions','created_at','When guest browsing began.'),
      ('guest_sessions','expires_at','Guest-session expiry as Unix time in seconds.'),

      ('order_messages','id','Unique message ID.'),
      ('order_messages','order_id','Order conversation this message belongs to.'),
      ('order_messages','sender_role','Whether the sender is a guest, registered buyer, or stall owner.'),
      ('order_messages','sender_user_id','Registered sender account when one exists; NULL for a guest.'),
      ('order_messages','sender_name','Display name shown beside the message.'),
      ('order_messages','message','Message text, limited to 1000 characters.'),
      ('order_messages','created_at','When the message was sent.'),

      ('guest_push_subscriptions','id','Unique guest-device subscription ID.'),
      ('guest_push_subscriptions','guest_session_id','Guest session that owns this device subscription.'),
      ('guest_push_subscriptions','endpoint','Private browser push endpoint URL.'),
      ('guest_push_subscriptions','subscription_json','Serialized push endpoint and encryption key material; keep private.'),
      ('guest_push_subscriptions','created_at','When the guest device subscription was saved.'),
      ('guest_push_subscriptions','updated_at','When it was last refreshed.'),

      ('notifications','id','Unique inbox notification ID.'),
      ('notifications','user_id','Registered recipient; NULL when the notification is for a guest.'),
      ('notifications','guest_session_id','Guest recipient; NULL when the notification is for a registered account.'),
      ('notifications','title','Short notification heading.'),
      ('notifications','body','Notification details.'),
      ('notifications','url','BiteHub destination to open when selected.'),
      ('notifications','tag','Grouping key for related notifications.'),
      ('notifications','created_at','When the notification was created.'),
      ('notifications','read_at','When it was marked as read; NULL means unread.'),

      ('weekly_menu_slots','id','Unique repeating-menu slot ID.'),
      ('weekly_menu_slots','stall_id','Stall that owns this repeating menu slot.'),
      ('weekly_menu_slots','product_id','Food item scheduled for the slot.'),
      ('weekly_menu_slots','weekday','Day of week as 0 through 6.'),
      ('weekly_menu_slots','service_period','School break period such as Morning break or Lunch.'),
      ('weekly_menu_slots','created_at','When this repeating slot was created.'),
      ('weekly_menu_slots','updated_at','When this repeating slot was last changed.'),

      ('admin_passkeys','credential_id','Unique public identifier for the registered passkey.'),
      ('admin_passkeys','user_id','School-admin account that registered the passkey.'),
      ('admin_passkeys','credential_public_key','Public verification key; no private key is stored here.'),
      ('admin_passkeys','sign_count','Authenticator counter used in passkey verification.'),
      ('admin_passkeys','transports','JSON text describing supported passkey transports.'),
      ('admin_passkeys','created_at','When the passkey was registered.'),

      ('webauthn_challenges','challenge_token_hash','Hash of the one-use server challenge lookup token.'),
      ('webauthn_challenges','purpose','Whether the challenge is for passkey registration or login.'),
      ('webauthn_challenges','challenge','Short-lived random challenge bytes returned to the authenticator.'),
      ('webauthn_challenges','user_id','Admin account associated with registration; may be NULL during login.'),
      ('webauthn_challenges','session_hash','Admin session hash used to bind a registration challenge.'),
      ('webauthn_challenges','expires_at','Challenge expiry as Unix time in seconds.'),

      ('admin_activity','id','Unique audit-event ID.'),
      ('admin_activity','actor_user_id','Admin account that performed the change, if the account still exists.'),
      ('admin_activity','actor_label','Admin display-name snapshot recorded at action time.'),
      ('admin_activity','action','Action category such as deleting a product or restoring a stall.'),
      ('admin_activity','target_type','Kind of affected object, such as stall, product, or campus control.'),
      ('admin_activity','target_id','ID of the affected object. Deliberately not a foreign key so audit history survives removal.'),
      ('admin_activity','target_label','Readable name of the affected object at action time.'),
      ('admin_activity','details_json','JSON text snapshot needed to explain or restore the action.'),
      ('admin_activity','created_at','When the admin action occurred.'),
      ('admin_activity','restored_at','When the affected item was restored; NULL means not restored.'),
      ('admin_activity','restored_by','Admin account that restored the item, when applicable.')
    ) AS descriptions(table_name, column_name, description)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'bitehub_app'
        AND c.relname = item.table_name
        AND a.attname = item.column_name
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) THEN
      EXECUTE format('COMMENT ON COLUMN %I.%I.%I IS %L',
        'bitehub_app', item.table_name, item.column_name, item.description);
    END IF;
  END LOOP;
END;
$bitehub_comments$;

COMMIT;
