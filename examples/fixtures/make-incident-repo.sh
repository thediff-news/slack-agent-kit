#!/bin/bash
# Builds examples/fixtures/incident-repo with a two-commit history:
# v1 sane pricing, v2 the commit that introduced the crash.
set -e
DIR="$(dirname "$0")/incident-repo"
mkdir -p "$DIR/src"
cd "$DIR"
if [ ! -d .git ]; then git init -q -b main; fi

cat > src/pricing.py <<'PY'
def apply_discount(cart_total, coupon):
    if coupon is None:
        return cart_total
    return cart_total - int(coupon["percent"])
PY
cat > src/checkout.py <<'PY'
from pricing import apply_discount

def checkout(cart_total, coupon):
    return apply_discount(cart_total, coupon)
PY
git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "pricing: handle missing coupon safely" --allow-empty

cat > src/pricing.py <<'PY'
def apply_discount(cart_total, coupon):
    # simplified: coupons are always present in the new flow
    return cart_total - int(coupon["percent"])
PY
git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "simplify coupon handling for new checkout flow"
echo "incident-repo ready at $DIR"
