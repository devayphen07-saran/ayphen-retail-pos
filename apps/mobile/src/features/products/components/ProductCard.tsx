import { memo } from 'react';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Typography } from '@ayphen/mobile-ui-components';
import type { LocalProduct } from '@core/sync/repositories/product.repository';

export const ProductCard = memo(function ProductCard({ product }: { product: LocalProduct }) {
  const { theme } = useMobileTheme();
  return (
    <Column
      gap={2}
      style={{ paddingVertical: theme.sizing.small, paddingHorizontal: theme.sizing.medium }}
    >
      <Typography.Body weight="medium">{product.name}</Typography.Body>
      <Typography.Caption type="secondary">
        {product.sku ? `SKU ${product.sku} · ` : ''}
        {'₹'}
        {product.sellingPrice}
      </Typography.Caption>
    </Column>
  );
});
