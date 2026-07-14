import { memo, useCallback, useState } from 'react';
import { TouchableOpacity, View, type LayoutChangeEvent } from 'react-native';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, Typography } from '@ayphen/mobile-ui-components';

import type { LocalProduct } from '@core/sync/repositories/product.repository';
import { RecordImage, type RemoteRecordImage } from '@features/attachments';

interface ProductGridCardProps {
  product: LocalProduct;
  qtyInCart: number;
  onPress: () => void;
  remoteFile?: RemoteRecordImage | null;
}

/**
 * Convert a canonical rupee string to a formatted INR value.
 * Invalid values fall back to the unformatted source value.
 */
function formatMoney(value: string | null | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    return 'Price unavailable';
  }

  const amount = Number(normalized);

  if (!Number.isFinite(amount)) {
    return `₹${normalized}`;
  }

  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Product tile for the POS grid.
 *
 * Displays a full-width square image followed by the product name and price.
 * The quantity badge and selected border represent cart state, not stock.
 */
export const ProductGridCard = memo(function ProductGridCard({
  product,
  qtyInCart,
  onPress,
  remoteFile,
}: ProductGridCardProps) {
  const { theme } = useMobileTheme();
  const [imageSize, setImageSize] = useState(0);

  const normalizedQuantity =
    Number.isFinite(qtyInCart) && qtyInCart > 0 ? qtyInCart : 0;

  const selected = normalizedQuantity > 0;

  const price = formatMoney(product.sellingPrice);

  const accessibilityLabel = selected
    ? `${product.name}, ${price}, ${normalizedQuantity} in cart`
    : `${product.name}, ${price}`;

  const onImageLayout = useCallback((event: LayoutChangeEvent) => {
    const measuredWidth = event.nativeEvent.layout.width;

    const nextSize = Number.isFinite(measuredWidth)
      ? Math.max(0, Math.floor(measuredWidth))
      : 0;

    setImageSize((currentSize) =>
      currentSize === nextSize ? currentSize : nextSize,
    );
  }, []);

  return (
    <CardTouchable
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Adds one item to the cart"
      accessibilityState={{ selected }}
    >
      {/*
       * Keep the shadow outside the clipping layer. The inner layer needs
       * overflow hidden for the full-bleed image and rounded corners.
       */}
      <ShadowWrapper>
        <CardInner $selected={selected}>
          {/*
           * aspectRatio reserves the square before measurement completes,
           * preventing the card from jumping during its first render.
           */}
          <ImageContainer onLayout={onImageLayout}>
            {imageSize > 0 ? (
              <RecordImage
                recordGuuid={product.guuid}
                label={product.name}
                remoteFile={remoteFile}
                size={imageSize}
                radius={0}
                showStatusBadge={false}
              />
            ) : null}

            {selected ? (
              <QuantityBadge
                accessible={false}
                pointerEvents="none"
                importantForAccessibility="no-hide-descendants"
              >
                <Typography.Caption weight="bold" color={theme.colorWhite}>
                  {normalizedQuantity}
                </Typography.Caption>
              </QuantityBadge>
            ) : null}
          </ImageContainer>

          {/*
           * Reserving two lines for the name keeps every tile the same
           * height regardless of the product-name length.
           */}
          <Column gap="xxSmall" padding="xSmall">
            {/* minHeight reserves two name lines so every tile is the same
                height regardless of name length. */}
            <ProductNameText weight="semiBold" numberOfLines={2}>
              {product.name}
            </ProductNameText>

            <PriceText weight="bold" color={theme.colorPrimary} numberOfLines={1}>
              {price}
            </PriceText>
          </Column>
        </CardInner>
      </ShadowWrapper>
    </CardTouchable>
  );
});

// ─── Styles ─────────────────────────────────────────────────────────────────

const CardTouchable = styled(TouchableOpacity)`
  flex: 1;
  margin: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const ShadowWrapper = styled(View)`
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  ${({ theme }) => theme.shadow.sm}
`;

const CardInner = styled(Column)<{ $selected: boolean }>`
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  overflow: hidden;
  border-width: ${({ theme }) => theme.borderWidth.light}px;
  border-color: ${({ $selected, theme }) =>
    $selected ? theme.colorPrimary : theme.colorBorderSecondary};
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const ImageContainer = styled(View)`
  width: 100%;
  aspect-ratio: 1.15;
  /* The image is a square sized to the tile WIDTH; the container is 1.15 (a bit
     shorter), so clip the overflow instead of letting it spill onto the name. */
  overflow: hidden;
  background-color: ${({ theme }) => theme.colorBgContainer};
`;

const QuantityBadge = styled(View)`
  position: absolute;
  top: 6px;
  right: 6px;
  min-width: 22px;
  height: 22px;
  padding-horizontal: 5px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  align-items: center;
  justify-content: center;
  background-color: ${({ theme }) => theme.colorPrimary};
`;

/** 12px / two-line name — matches the reference POS tile (Body 16px is too large
 *  for a dense 3-column grid). min-height reserves 2 lines for uniform tiles. */
const ProductNameText = styled(Typography.Caption)`
  font-size: 12px;
  line-height: 16px;
  min-height: 32px;
`;

/** 14px bold price — larger than the 12px caption, smaller than 16px Body. */
const PriceText = styled(Typography.Caption)`
  font-size: 14px;
  margin-top: 3px;
`;
