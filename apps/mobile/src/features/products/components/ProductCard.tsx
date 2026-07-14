import { memo } from 'react';
import { TouchableOpacity } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, LucideIcon, Row, Typography } from '@ayphen/mobile-ui-components';
import { RecordImage, type RemoteRecordImage } from '@features/attachments';
import type { LocalProduct } from '@core/sync/repositories/product.repository';
import { StockBadge } from './StockBadge';

/** Money string → "₹1,234.50". Falls back to the raw value if it isn't numeric. */
function formatMoney(value: string | null): string {
  if (!value) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return `₹${value}`;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const ProductCard = memo(function ProductCard({
  product,
  onPress,
  remoteFile,
  stockQuantity,
}: {
  product: LocalProduct;
  onPress?: () => void;
  /** Server file for this product (batched grid fetch). Lets a non-capturing
   *  device render the image via expo-image (disk-cached by the stable file
   *  guuid) — see RecordImage's resolution order. Null → local thumb or the
   *  initials placeholder. */
  remoteFile?: RemoteRecordImage | null;
  /** On-hand stock. Renders the StockBadge when provided; omit (undefined) to
   *  hide it. NOTE: there is no real inventory quantity in the data model yet —
   *  the caller currently passes a placeholder (see ProductsScreen). */
  stockQuantity?: number | null;
}) {
  const { theme } = useMobileTheme();
  const codes = [product.sku, product.barcode].filter(Boolean).join(' · ');
  // Strike-through MRP only when it's genuinely higher than the selling price —
  // i.e. there's a real discount to communicate (canonical money strings).
  const hasDiscount = product.mrp != null && Number(product.mrp) > Number(product.sellingPrice);

  const content = (
    <CardRow align="center" gap="small">
      <RecordImage
        recordGuuid={product.guuid}
        label={product.name}
        remoteFile={remoteFile}
        size={48}
        radius={theme.borderRadius.medium}
      />

      <Column flex={1} gap={2}>
        <Typography.Body weight="semiBold" numberOfLines={1}>
          {product.name}
        </Typography.Body>
        {codes ? (
          <Typography.Caption type="secondary" numberOfLines={1}>
            {codes}
          </Typography.Caption>
        ) : null}
      </Column>

      <Column align="flex-end" gap={4}>
        <Row align="center" gap={6}>
          {hasDiscount ? (
            <StrikethroughCaption type="secondary">{formatMoney(product.mrp)}</StrikethroughCaption>
          ) : null}
          <Typography.Body weight="bold" color={theme.colorPrimary}>
            {formatMoney(product.sellingPrice)}
          </Typography.Body>
        </Row>
        {stockQuantity != null ? <StockBadge quantity={stockQuantity} /> : null}
      </Column>

      <LucideIcon name="ChevronRight" size={18} color={theme.colorTextTertiary} />
    </CardRow>
  );

  if (!onPress) return content;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6} accessibilityRole="button">
      {content}
    </TouchableOpacity>
  );
});

const CardRow = styled(Row)`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
`;

const StrikethroughCaption = styled(Typography.Caption)`
  text-decoration-line: line-through;
`;