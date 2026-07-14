import { memo } from 'react';
import { Tag } from '@ayphen/mobile-ui-components';

/**
 * On-hand stock pill: green "N in stock" / red "Out of stock", matching the
 * products reference. Presentational only — it renders whatever `quantity` it's
 * given; deciding what that number is (and whether it's real) is the caller's
 * job. `lowThreshold` optionally tints a running-low count amber.
 *
 * Thin wrapper around the catalogue `Tag` component: maps the quantity/threshold
 * to a `variant` ("danger" | "warning" | "success") instead of hand-rolling a
 * colored pill.
 */
export const StockBadge = memo(function StockBadge({
  quantity,
  lowThreshold = 0,
}: {
  quantity: number;
  lowThreshold?: number;
}) {
  const variant = quantity <= 0 ? 'danger' : quantity <= lowThreshold ? 'warning' : 'success';
  const label =
    quantity <= 0
      ? 'Out of stock'
      : `${quantity.toLocaleString('en-IN')} in stock${quantity <= lowThreshold ? ' (low)' : ''}`;

  return <Tag label={label} variant={variant} size="xsm" alignSelf="flex-end" />;
});
