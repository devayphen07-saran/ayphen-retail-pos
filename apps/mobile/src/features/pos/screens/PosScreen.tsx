import { useCallback, useEffect, useMemo, useState } from 'react';
import { TouchableOpacity, View } from 'react-native';
import styled from 'styled-components/native';
import { and, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite/query';
import { router } from 'expo-router';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  Alert,
  AppLayout,
  Column,
  IconButton,
  ListScaffold,
  LucideIcon,
  Row,
  SearchBar,
  Typography,
  formatMinorUnits,
} from '@ayphen/mobile-ui-components';

import { usePermission } from '@core/auth/usePermission';
import { getSyncDbForQueries } from '@core/sync/db/client';
import { products } from '@core/sync/db/schema';
import type { LocalProduct } from '@core/sync/repositories/product.repository';
import { useRecordRemoteImages } from '@features/attachments';
import { SyncStatusIcon } from '@features/sync';
import { useActiveStoreStore } from '@store';

import { useDebouncedValue } from '../../../utils/useDebouncedValue';
import { ProductGridCard } from '../components/ProductGridCard';
import { usePosCartStore } from '../store/cart-store';
import { cartTotalPaise } from '../types/cart';
import { rupeesStringToPaise } from '../utils/money';

export function PosScreen() {
  const { theme } = useMobileTheme();

  const storeId = useActiveStoreStore((state) => state.storeId) ?? '';

  const [search, setSearch] = useState('');

  const canSell = usePermission('Sale', 'create');

  const cart = usePosCartStore((state) => state.lines);
  const bindStore = usePosCartStore((state) => state.bindStore);
  const addProduct = usePosCartStore((state) => state.addProduct);

  /*
   * A cart is scoped to one store. Binding clears it whenever the active store
   * changes. The persisted cart hydrates asynchronously, so we reconcile scope
   * only once hydration has finished — otherwise a cart restored from another
   * store could land on top of a fresh bind.
   */
  useEffect(() => {
    setSearch('');

    const bind = () => bindStore(storeId);

    if (usePosCartStore.persist.hasHydrated()) {
      bind();
      return;
    }

    return usePosCartStore.persist.onFinishHydration(bind);
  }, [bindStore, storeId]);

  const productsQuery = useMemo(
    () =>
      getSyncDbForQueries()
        .select()
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.isActive, true))),
    [storeId],
  );

  const { data: productRows, error: productsError } = useLiveQuery(
    productsQuery,
    [storeId],
  );

  /*
   * Live database rows are not debounced because doing so can briefly show
   * products belonging to the previously active store.
   */
  const allProducts = useMemo(
    () => (productRows ?? []).filter((product) => product.storeId === storeId),
    [productRows, storeId],
  );

  const debouncedSearch = useDebouncedValue(search, 200);

  const filteredProducts = useMemo(() => {
    const term = debouncedSearch.trim().toLocaleLowerCase();

    if (!term) {
      return allProducts;
    }

    return allProducts.filter((product) => {
      const nameMatches = product.name.toLocaleLowerCase().includes(term);

      const skuMatches =
        product.sku?.toLocaleLowerCase().includes(term) ?? false;

      const barcodeMatches =
        product.barcode?.toLocaleLowerCase().includes(term) ?? false;

      return nameMatches || skuMatches || barcodeMatches;
    });
  }, [allProducts, debouncedSearch]);

  const cartByProductId = useMemo(
    () => new Map(cart.map((line) => [line.productId, line.qty] as const)),
    [cart],
  );

  const totalPaise = useMemo(() => cartTotalPaise(cart), [cart]);

  const totalUnits = useMemo(
    () => cart.reduce((sum, line) => sum + line.qty, 0),
    [cart],
  );

  const { remoteByGuuid, viewabilityProps } = useRecordRemoteImages(
    storeId,
    'Product',
  );

  const addToCart = useCallback(
    (product: LocalProduct) => {
      if (!canSell) {
        Alert.info(
          'Not allowed',
          "You don't have permission to make sales in this store.",
        );
        return;
      }

      /*
       * Validate the raw price string directly. `rupeesStringToPaise` returns 0
       * for a non-numeric value, which is indistinguishable from a real ₹0 — so
       * a garbage price would otherwise be added silently as a free line.
       */
      const rawPrice = product.sellingPrice?.trim() ?? '';
      const parsedRupees = Number(rawPrice);

      if (rawPrice === '' || !Number.isFinite(parsedRupees) || parsedRupees < 0) {
        Alert.info(
          'Invalid product price',
          `${product.name} does not have a valid selling price.`,
        );
        return;
      }

      const unitPricePaise = rupeesStringToPaise(product.sellingPrice);

      if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) {
        Alert.info(
          'Invalid product price',
          `${product.name} does not have a valid selling price.`,
        );
        return;
      }

      addProduct({
        productId: product.id,
        productGuuid: product.guuid,
        name: product.name,
        unitPricePaise,
      });
    },
    [addProduct, canSell],
  );

  const renderItem = useCallback(
    ({ item }: { item: LocalProduct }) => (
      <ProductGridCard
        product={item}
        qtyInCart={cartByProductId.get(item.id) ?? 0}
        onPress={() => addToCart(item)}
        remoteFile={remoteByGuuid.get(item.guuid) ?? null}
      />
    ),
    [addToCart, cartByProductId, remoteByGuuid],
  );

  const openCart = useCallback(() => {
    if (
      cart.length === 0 ||
      !Number.isSafeInteger(totalPaise) ||
      totalPaise <= 0
    ) {
      return;
    }

    router.push('/(store)/cart');
  }, [cart.length, totalPaise]);

  const headerActions = (
    <Row align="center" gap="small">
      <IconButton
        variant="ghost"
        size={36}
        iconName="ScanBarcode"
        color={theme.colorPrimary}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Scan barcode"
        hitSlop={8}
        onPress={() => Alert.info('Barcode scanner', 'Coming soon.')}
      />

      <SyncStatusIcon size={36} />

      <IconButton
        variant="ghost"
        size={36}
        iconName="Receipt"
        color={theme.colorPrimary}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="View sales"
        hitSlop={8}
        onPress={() => router.push('/(store)/sales')}
      />
    </Row>
  );

  return (
    <AppLayout title="Point of Sale" rightElement={headerActions}>
      <SearchBar
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name, SKU, barcode…"
      />

      <ListScaffold<LocalProduct>
        data={filteredProducts}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        numColumns={3}
        isThemed={false}
        onViewableItemsChanged={viewabilityProps.onViewableItemsChanged}
        viewabilityConfig={viewabilityProps.viewabilityConfig}
        listProps={{
          refetch: () => undefined,
        }}
        loaderProps={{
          isLoading: false,
          isFetching: false,
          loadingCard: () => null,
          loaderLength: 0,
        }}
        emptyState={
          productsError
            ? {
                message: "Couldn't load products",
                description: productsError.message,
                icon: 'TriangleAlert',
              }
            : search.trim()
              ? {
                  message: 'No matches',
                  description: 'Try a different search.',
                  icon: 'Search',
                  filterActive: true,
                  onClearFilters: () => setSearch(''),
                }
              : {
                  message: 'No active products',
                  description: 'Add products to start selling.',
                  icon: 'PackageX',
                }
        }
      />

      {cart.length > 0 && canSell ? (
        <CartFooter padding="medium">
          <TouchableOpacity
            onPress={openCart}
            disabled={!Number.isSafeInteger(totalPaise) || totalPaise <= 0}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Open cart, ${cart.length} products, ${totalUnits} quantity, ${formatMinorUnits(
              totalPaise,
              {
                currency: 'INR',
              },
            )}`}
            accessibilityState={{
              disabled: !Number.isSafeInteger(totalPaise) || totalPaise <= 0,
            }}
          >
            <CartSummaryPill align="center" gap={theme.sizing.small}>
              <View>
                <LucideIcon
                  name="ShoppingCart"
                  size={24}
                  color={theme.colorWhite}
                />

                <CartBadge
                  accessible={false}
                  pointerEvents="none"
                  importantForAccessibility="no-hide-descendants"
                >
                  <Typography.Caption weight="bold" color={theme.colorWhite}>
                    {cart.length}
                  </Typography.Caption>
                </CartBadge>
              </View>

              <CartSummaryText flex={1}>
                <Typography.Body weight="bold" color={theme.colorWhite}>
                  {cart.length} product
                  {cart.length === 1 ? '' : 's'} · {totalUnits} qty
                </Typography.Body>

                <Typography.Caption color={theme.overlay.onDark55}>
                  Tap to view cart
                </Typography.Caption>
              </CartSummaryText>

              <Typography.Subtitle weight="bold" color={theme.colorWhite}>
                {formatMinorUnits(totalPaise, {
                  currency: 'INR',
                })}
              </Typography.Subtitle>

              <LucideIcon name="ChevronUp" size={20} color={theme.colorWhite} />
            </CartSummaryPill>
          </TouchableOpacity>
        </CartFooter>
      ) : null}
    </AppLayout>
  );
}

const CartFooter = styled(Column)`
  background-color: transparent;
`;

const CartSummaryPill = styled(Row)`
  padding-vertical: ${({ theme }) => theme.sizing.small}px;
  padding-horizontal: ${({ theme }) => theme.sizing.medium}px;
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  background-color: #1c2455;
`;

const CartBadge = styled(View)`
  position: absolute;
  top: -6px;
  right: -8px;
  min-width: 18px;
  height: 18px;
  padding-horizontal: ${({ theme }) => theme.sizing.xxSmall}px;
  border-radius: ${({ theme }) => theme.borderRadius.full}px;
  background-color: ${({ theme }) => theme.colorError};
  align-items: center;
  justify-content: center;
`;

const CartSummaryText = styled(Column)`
  margin-left: ${({ theme }) => theme.sizing.xSmall}px;
`;
