import {
  useCallback,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  Alert as RNAlert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  LucideIcon,
  Typography,
} from '@ayphen/mobile-ui-components';

import type { LocalCustomer } from '@core/sync/repositories/customer.repository';
import type { LocalPaymentAccount } from '@core/sync/repositories/payment-account.repository';

import type { CartLine } from '../../types/cart';
import { CashPaymentPage } from './CashPaymentPage';
import { CheckoutPage } from './CheckoutPage';
import { formatPaise } from './format';
import { PaymentSuccessPage } from './PaymentSuccessPage';

type FlowScreen =
  | 'cart'
  | 'checkout'
  | 'cash'
  | 'success';

export type CommitSelection =
  | {
      kind: 'account';
      account: LocalPaymentAccount;
    }
  | {
      kind: 'credit';
      customer: LocalCustomer;
    };

interface PaymentMeta {
  methodLabel: string;
  totalPaise: number;
  tenderedPaise?: number;
  changePaise?: number;
}

export interface CartScreenProps {
  lines: CartLine[];
  totalPaise: number;
  totalUnits: number;
  accounts: LocalPaymentAccount[];
  customers: LocalCustomer[];
  selectedCustomer?: LocalCustomer;
  onSetCustomer: (
    customer?: LocalCustomer,
  ) => void;
  onChangeQty: (
    productId: string,
    quantity: number,
  ) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
  onClose: () => void;

  /**
   * Enqueue the completed sale. Resolves when the mutation has been written
   * successfully and rejects when the sale could not be recorded.
   */
  onCommit: (
    selection: CommitSelection,
  ) => Promise<void>;

  overLimit: boolean;
  remainingPaise: number;
  limitPaise: number;
  isOffline: boolean;
}

const AVATAR_PALETTE = [
  { bg: '#EEF2FF', text: '#4F46E5' },
  { bg: '#FEF3C7', text: '#D97706' },
  { bg: '#DCFCE7', text: '#16A34A' },
  { bg: '#FCE7F3', text: '#DB2777' },
  { bg: '#F3E8FF', text: '#9333EA' },
  { bg: '#FFEDD5', text: '#EA580C' },
  { bg: '#CFFAFE', text: '#0891B2' },
  { bg: '#FEE2E2', text: '#DC2626' },
] as const;

function avatarColor(initial: string) {
  const code = initial.charCodeAt(0) || 0;
  const index = code % AVATAR_PALETTE.length;

  return AVATAR_PALETTE[index]!;
}

function isValidTotal(totalPaise: number): boolean {
  return (
    Number.isSafeInteger(totalPaise) &&
    totalPaise > 0
  );
}

export function CartScreen({
  lines,
  totalPaise,
  totalUnits,
  accounts,
  customers,
  selectedCustomer,
  onSetCustomer,
  onChangeQty,
  onRemove,
  onClear,
  onClose,
  onCommit,
  overLimit,
  remainingPaise,
  limitPaise,
  isOffline,
}: CartScreenProps): ReactElement {
  const { theme } = useMobileTheme();

  const [flow, setFlow] =
    useState<FlowScreen>('cart');
  const [
    pendingAccount,
    setPendingAccount,
  ] = useState<LocalPaymentAccount | null>(
    null,
  );
  const [paymentMeta, setPaymentMeta] =
    useState<PaymentMeta | null>(null);
  const [submitting, setSubmitting] =
    useState(false);
  const [pickerOpen, setPickerOpen] =
    useState(false);

  /*
   * React state updates asynchronously. This ref prevents two rapid payment
   * taps from calling the commit handler before `submitting` has rendered.
   */
  const submittingRef = useRef(false);

  const creditEnabled =
    customers.length > 0;

  const hasPaymentMethod =
    accounts.length > 0 || creditEnabled;

  const canCheckout =
    lines.length > 0 &&
    isValidTotal(totalPaise) &&
    hasPaymentMethod &&
    !submitting;

  const runCommit = useCallback(
    async (
      selection: CommitSelection,
      metadata: PaymentMeta,
    ): Promise<void> => {
      if (
        submittingRef.current ||
        !isValidTotal(metadata.totalPaise)
      ) {
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);

      try {
        await onCommit(selection);
        setPaymentMeta(metadata);
        setFlow('success');
      } catch {
        RNAlert.alert(
          'Could not record sale',
          'Something went wrong. Please try again.',
        );
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [onCommit],
  );

  const handleSelectAccount = useCallback(
    (account: LocalPaymentAccount) => {
      if (submittingRef.current) {
        return;
      }

      if (account.kind === 'cash') {
        setPendingAccount(account);
        setFlow('cash');
        return;
      }

      void runCommit(
        {
          kind: 'account',
          account,
        },
        {
          methodLabel: account.name,
          totalPaise,
        },
      );
    },
    [runCommit, totalPaise],
  );

  const handleSelectCredit =
    useCallback(() => {
      if (submittingRef.current) {
        return;
      }

      if (!selectedCustomer) {
        RNAlert.alert(
          'Add a customer',
          'Customer credit needs a customer. Select one from the cart first.',
        );
        setFlow('cart');
        return;
      }

      const selection: CommitSelection = {
        kind: 'credit',
        customer: selectedCustomer,
      };

      const metadata: PaymentMeta = {
        methodLabel:
          `Credit · ${selectedCustomer.name}`,
        totalPaise,
      };

      if (overLimit) {
        RNAlert.alert(
          'Over credit limit',
          `This exceeds ${selectedCustomer.name}'s credit limit. The sale can still be recorded and flagged for review.`,
          [
            {
              text: 'Cancel',
              style: 'cancel',
            },
            {
              text: 'Record anyway',
              onPress: () => {
                void runCommit(
                  selection,
                  metadata,
                );
              },
            },
          ],
        );
        return;
      }

      void runCommit(selection, metadata);
    }, [
      overLimit,
      runCommit,
      selectedCustomer,
      totalPaise,
    ]);

  const handleTender = useCallback(
    (
      tenderedPaise: number,
      changePaise: number,
    ) => {
      if (
        !pendingAccount ||
        !Number.isSafeInteger(
          tenderedPaise,
        ) ||
        !Number.isSafeInteger(changePaise) ||
        tenderedPaise < totalPaise ||
        changePaise < 0
      ) {
        return;
      }

      void runCommit(
        {
          kind: 'account',
          account: pendingAccount,
        },
        {
          methodLabel:
            pendingAccount.name,
          totalPaise,
          tenderedPaise,
          changePaise,
        },
      );
    },
    [
      pendingAccount,
      runCommit,
      totalPaise,
    ],
  );

  const handleClearCart =
    useCallback(() => {
      RNAlert.alert(
        'Clear cart',
        'Remove all items from the cart?',
        [
          {
            text: 'Cancel',
            style: 'cancel',
          },
          {
            text: 'Clear',
            style: 'destructive',
            onPress: () => {
              onClear();
              onClose();
            },
          },
        ],
      );
    }, [onClear, onClose]);

  const renderLine = useCallback(
    ({ item }: { item: CartLine }) => {
      const initial =
        item.name
          .trim()
          .charAt(0)
          .toUpperCase() || '?';

      const avatar =
        avatarColor(initial);

      const lineTotal = Math.round(
        item.qty * item.unitPricePaise,
      );

      const safeLineTotal =
        Number.isSafeInteger(lineTotal)
          ? lineTotal
          : 0;

      const decreaseQuantity = () => {
        if (submitting) {
          return;
        }

        if (item.qty <= 1) {
          onRemove(item.productId);
        } else {
          onChangeQty(
            item.productId,
            item.qty - 1,
          );
        }
      };

      const increaseQuantity = () => {
        if (submitting) {
          return;
        }

        onChangeQty(
          item.productId,
          item.qty + 1,
        );
      };

      return (
        <LineItem>
          <InitialBox
            style={{
              backgroundColor: avatar.bg,
            }}
          >
            <InitialText
              style={{
                color: avatar.text,
              }}
            >
              {initial}
            </InitialText>
          </InitialBox>

          <LineInfo>
            <Typography.Body
              weight="semiBold"
              color={theme.colorText}
              numberOfLines={1}
            >
              {item.name}
            </Typography.Body>

            <Typography.Caption
              color={
                theme.colorTextSecondary
              }
              numberOfLines={1}
            >
              {formatPaise(
                item.unitPricePaise,
              )}{' '}
              each
            </Typography.Caption>
          </LineInfo>

          <LineRight>
            <StepperMini
              style={{
                backgroundColor:
                  theme.colorFillSecondary,
              }}
            >
              <StepMiniBtn
                onPress={decreaseQuantity}
                disabled={submitting}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={
                  item.qty <= 1
                    ? `Remove ${item.name}`
                    : `Decrease ${item.name} quantity`
                }
              >
                <LucideIcon
                  name={
                    item.qty <= 1
                      ? 'Trash2'
                      : 'Minus'
                  }
                  size={13}
                  color={
                    item.qty <= 1
                      ? theme.colorError
                      : theme.colorTextSecondary
                  }
                />
              </StepMiniBtn>

              <QtyText
                style={{
                  color:
                    theme.colorPrimary,
                }}
              >
                {item.qty}
              </QtyText>

              <StepMiniBtn
                onPress={increaseQuantity}
                disabled={submitting}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Increase ${item.name} quantity`}
              >
                <LucideIcon
                  name="Plus"
                  size={13}
                  color={
                    theme.colorTextSecondary
                  }
                />
              </StepMiniBtn>
            </StepperMini>

            <Typography.Body
              weight="bold"
              color={theme.colorText}
            >
              {formatPaise(
                safeLineTotal,
              )}
            </Typography.Body>
          </LineRight>
        </LineItem>
      );
    },
    [
      onChangeQty,
      onRemove,
      submitting,
      theme,
    ],
  );

  if (flow === 'checkout') {
    return (
      <CheckoutPage
        totalPaise={totalPaise}
        accounts={accounts}
        creditEnabled={creditEnabled}
        selectedCustomer={
          selectedCustomer
        }
        submitting={submitting}
        onBack={() => {
          if (!submitting) {
            setFlow('cart');
          }
        }}
        onEditCart={() => {
          if (!submitting) {
            setFlow('cart');
          }
        }}
        onSelectAccount={
          handleSelectAccount
        }
        onSelectCredit={
          handleSelectCredit
        }
      />
    );
  }

  if (flow === 'cash') {
    return (
      <CashPaymentPage
        totalPaise={totalPaise}
        submitting={submitting}
        onBack={() => {
          if (!submitting) {
            setPendingAccount(null);
            setFlow('checkout');
          }
        }}
        onTender={handleTender}
      />
    );
  }

  if (
    flow === 'success' &&
    paymentMeta
  ) {
    return (
      <PaymentSuccessPage
        totalPaise={
          paymentMeta.totalPaise
        }
        methodLabel={
          paymentMeta.methodLabel
        }
        tenderedPaise={
          paymentMeta.tenderedPaise
        }
        changePaise={
          paymentMeta.changePaise
        }
        offline={isOffline}
        onNewSale={onClose}
        onPrint={() =>
          RNAlert.alert(
            'Print',
            'Printing receipts is coming soon.',
          )
        }
        onShare={() =>
          RNAlert.alert(
            'Share',
            'Sharing receipts is coming soon.',
          )
        }
      />
    );
  }

  return (
    <Root
      style={{
        backgroundColor:
          theme.colorBgLayout,
      }}
    >
      <SafeAreaView
        edges={['top']}
        style={{
          backgroundColor:
            theme.colorBgContainer,
        }}
      >
        <Header
          style={{
            backgroundColor:
              theme.colorBgContainer,
            borderBottomColor:
              theme.colorBorderSecondary,
          }}
        >
          <TouchableOpacity
            onPress={onClose}
            disabled={submitting}
            hitSlop={8}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close cart"
          >
            <LucideIcon
              name="ArrowLeft"
              size={22}
              color={theme.colorText}
            />
          </TouchableOpacity>

          <HeaderCenter>
            <Typography.Body
              weight="bold"
              color={theme.colorText}
            >
              Cart
            </Typography.Body>

            <CountChip
              style={{
                backgroundColor:
                  theme.colorPrimaryBg,
              }}
            >
              <Typography.Overline
                weight="bold"
                color={
                  theme.colorPrimary
                }
              >
                {lines.length}{' '}
                {lines.length === 1
                  ? 'product'
                  : 'products'}{' '}
                · {totalUnits} qty
              </Typography.Overline>
            </CountChip>
          </HeaderCenter>

          {lines.length > 0 ? (
            <TouchableOpacity
              onPress={handleClearCart}
              disabled={submitting}
              hitSlop={8}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Clear cart"
            >
              <LucideIcon
                name="Trash2"
                size={20}
                color={theme.colorError}
              />
            </TouchableOpacity>
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </Header>

        <CustomerPickerRow
          onPress={() =>
            setPickerOpen(true)
          }
          disabled={submitting}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={
            selectedCustomer
              ? `Selected customer ${selectedCustomer.name}`
              : 'Select customer'
          }
          style={{
            backgroundColor:
              theme.colorBgContainer,
            borderBottomColor:
              theme.colorBorderSecondary,
          }}
        >
          <CustomerIconBox
            style={{
              backgroundColor:
                selectedCustomer
                  ? theme.colorPrimaryBg
                  : theme.colorFillSecondary,
            }}
          >
            <LucideIcon
              name={
                selectedCustomer
                  ? 'UserCheck'
                  : 'UserPlus'
              }
              size={16}
              color={
                selectedCustomer
                  ? theme.colorPrimary
                  : theme.colorTextTertiary
              }
            />
          </CustomerIconBox>

          <View style={styles.fill}>
            {selectedCustomer ? (
              <>
                <Typography.Overline
                  weight="semiBold"
                  color={
                    theme.colorTextTertiary
                  }
                >
                  CUSTOMER
                </Typography.Overline>

                <Typography.Body
                  weight="semiBold"
                  color={theme.colorText}
                  numberOfLines={1}
                >
                  {selectedCustomer.name}
                </Typography.Body>
              </>
            ) : (
              <Typography.Body
                color={
                  theme.colorTextTertiary
                }
              >
                Add customer (optional)
              </Typography.Body>
            )}
          </View>

          <LucideIcon
            name="ChevronRight"
            size={16}
            color={
              theme.colorTextTertiary
            }
          />
        </CustomerPickerRow>
      </SafeAreaView>

      <ListCard
        style={{
          backgroundColor:
            theme.colorBgContainer,
        }}
      >
        <FlatList
          data={lines}
          keyExtractor={(item) =>
            item.productId
          }
          renderItem={renderLine}
          ItemSeparatorComponent={() => (
            <LineDivider
              style={{
                backgroundColor:
                  theme.colorBorderSecondary,
              }}
            />
          )}
          contentContainerStyle={
            styles.listContent
          }
          showsVerticalScrollIndicator={
            false
          }
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            lines.length > 0 ? (
              <AddItemsRow
                onPress={onClose}
                disabled={submitting}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Add more items"
                style={{
                  borderColor:
                    theme.colorBorderSecondary,
                }}
              >
                <LucideIcon
                  name="Plus"
                  size={15}
                  color={
                    theme.colorTextTertiary
                  }
                />

                <Typography.Caption
                  color={
                    theme.colorTextTertiary
                  }
                >
                  Add more items
                </Typography.Caption>
              </AddItemsRow>
            ) : null
          }
          ListEmptyComponent={
            <EmptyBox>
              <LucideIcon
                name="ShoppingCart"
                size={28}
                color={
                  theme.colorTextTertiary
                }
              />
              <Typography.Caption type="secondary">
                Your cart is empty
              </Typography.Caption>
            </EmptyBox>
          }
        />
      </ListCard>

      <SafeAreaView
        edges={['bottom']}
        style={{
          backgroundColor:
            theme.colorBgContainer,
        }}
      >
        <SummaryCard
          style={{
            backgroundColor:
              theme.colorBgContainer,
            borderTopColor:
              theme.colorBorderSecondary,
          }}
        >
          <SummaryRow>
            <Typography.Caption
              color={
                theme.colorTextSecondary
              }
            >
              Subtotal ({lines.length}{' '}
              {lines.length === 1
                ? 'item'
                : 'items'}
              , {totalUnits} units)
            </Typography.Caption>

            <Typography.Caption
              weight="medium"
              color={theme.colorText}
            >
              {formatPaise(totalPaise)}
            </Typography.Caption>
          </SummaryRow>

          {selectedCustomer &&
          limitPaise > 0 ? (
            <SummaryRow>
              <Typography.Caption
                color={
                  theme.colorTextSecondary
                }
              >
                {selectedCustomer.name}
                {"'s"} remaining credit
              </Typography.Caption>

              <Typography.Caption
                weight="medium"
                color={
                  overLimit
                    ? theme.colorError
                    : theme.colorTextSecondary
                }
              >
                {formatPaise(
                  Math.max(
                    remainingPaise,
                    0,
                  ),
                )}
              </Typography.Caption>
            </SummaryRow>
          ) : null}

          <SummaryDivider
            style={{
              backgroundColor:
                theme.colorBorderSecondary,
            }}
          />

          <CheckoutBtn
            onPress={() => {
              if (canCheckout) {
                setFlow('checkout');
              }
            }}
            disabled={!canCheckout}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={
              hasPaymentMethod
                ? `Checkout ${formatPaise(totalPaise)}`
                : 'No payment method available'
            }
            accessibilityState={{
              disabled: !canCheckout,
            }}
            style={{
              backgroundColor:
                canCheckout
                  ? theme.colorPrimary
                  : theme.colorFill,
            }}
          >
            <CheckoutBtnInner>
              <PayBtnLabel
                style={{
                  color: canCheckout
                    ? theme.colorWhite
                    : theme.colorTextTertiary,
                }}
              >
                {hasPaymentMethod
                  ? 'Checkout'
                  : 'Add a payment account or customer'}
              </PayBtnLabel>

              {canCheckout ? (
                <CheckoutAmountRow>
                  <PayBtnAmountText>
                    {formatPaise(
                      totalPaise,
                    )}
                  </PayBtnAmountText>

                  <LucideIcon
                    name="ChevronRight"
                    size={16}
                    color="rgba(255,255,255,0.8)"
                  />
                </CheckoutAmountRow>
              ) : null}
            </CheckoutBtnInner>
          </CheckoutBtn>
        </SummaryCard>
      </SafeAreaView>

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() =>
          setPickerOpen(false)
        }
      >
        <View style={styles.modalRoot}>
          <Pressable
            style={styles.modalOverlay}
            onPress={() =>
              setPickerOpen(false)
            }
            accessibilityRole="button"
            accessibilityLabel="Close customer picker"
          />

          <PickerSheet
            style={{
              backgroundColor:
                theme.colorBgContainer,
            }}
            edges={['bottom']}
          >
            <PickerHandle
              style={{
                backgroundColor:
                  theme.colorBorderSecondary,
              }}
            />

            <PickerTitle
              style={{
                color: theme.colorText,
              }}
            >
              Select customer
            </PickerTitle>

            <FlatList
              data={customers}
              keyExtractor={(item) =>
                item.id
              }
              style={styles.pickerList}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={
                <PickerItem
                  onPress={() => {
                    onSetCustomer(
                      undefined,
                    );
                    setPickerOpen(false);
                  }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Use walk-in customer"
                  style={{
                    borderBottomColor:
                      theme.colorBorderSecondary,
                  }}
                >
                  <LucideIcon
                    name="UserX"
                    size={18}
                    color={
                      theme.colorTextTertiary
                    }
                  />

                  <Typography.Body
                    color={
                      theme.colorTextSecondary
                    }
                  >
                    Walk-in (no customer)
                  </Typography.Body>
                </PickerItem>
              }
              renderItem={({ item }) => {
                const selected =
                  selectedCustomer?.id ===
                  item.id;

                return (
                  <PickerItem
                    onPress={() => {
                      onSetCustomer(item);
                      setPickerOpen(false);
                    }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${item.name}`}
                    accessibilityState={{
                      selected,
                    }}
                    style={{
                      borderBottomColor:
                        theme.colorBorderSecondary,
                    }}
                  >
                    <LucideIcon
                      name={
                        selected
                          ? 'CheckCircle2'
                          : 'User'
                      }
                      size={18}
                      color={
                        selected
                          ? theme.colorPrimary
                          : theme.colorTextTertiary
                      }
                    />

                    <View
                      style={styles.fill}
                    >
                      <Typography.Body
                        weight="medium"
                        color={
                          theme.colorText
                        }
                        numberOfLines={1}
                      >
                        {item.name}
                      </Typography.Body>

                      {item.phone ? (
                        <Typography.Caption
                          type="secondary"
                          numberOfLines={1}
                        >
                          {item.phone}
                        </Typography.Caption>
                      ) : null}
                    </View>
                  </PickerItem>
                );
              }}
              ListEmptyComponent={
                <EmptyBox>
                  <Typography.Caption type="secondary">
                    No customers yet
                  </Typography.Caption>
                </EmptyBox>
              }
            />
          </PickerSheet>
        </View>
      </Modal>
    </Root>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  headerSpacer: {
    width: 22,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor:
      'rgba(0, 0, 0, 0.35)',
  },
  pickerList: {
    maxHeight: 360,
  },
});

const Root = styled(View)`
  flex: 1;
`;

const Header = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom-width: 1px;
`;

const HeaderCenter = styled(View)`
  flex: 1;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
`;

const CountChip = styled(View)`
  padding: 3px 8px;
  border-radius: 12px;
`;

const CustomerPickerRow = styled(
  TouchableOpacity,
)`
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom-width: 1px;
`;

const CustomerIconBox = styled(View)`
  width: 34px;
  height: 34px;
  border-radius: 17px;
  align-items: center;
  justify-content: center;
`;

const ListCard = styled(View)`
  flex: 1;
  margin: 10px 12px;
  border-radius: 14px;
  overflow: hidden;
`;

const LineItem = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
`;

const InitialBox = styled(View)`
  width: 42px;
  height: 42px;
  border-radius: 12px;
  align-items: center;
  justify-content: center;
`;

const InitialText = styled.Text`
  font-size: 17px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const LineInfo = styled(View)`
  flex: 1;
`;

const LineRight = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 12px;
`;

const StepperMini = styled(View)`
  flex-direction: row;
  align-items: center;
  border-radius: 10px;
  padding: 3px 4px;
`;

const StepMiniBtn = styled(Pressable)`
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
`;

const QtyText = styled.Text`
  min-width: 26px;
  font-size: 15px;
  font-weight: 700;
  text-align: center;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const LineDivider = styled(View)`
  height: 1px;
  margin: 0 14px 0 68px;
`;

const AddItemsRow = styled(
  TouchableOpacity,
)`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  margin: 8px;
  border-radius: 10px;
  border-width: 1px;
  border-style: dashed;
`;

const EmptyBox = styled(View)`
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 16px;
`;

const SummaryCard = styled(View)`
  padding: 12px 16px 4px;
  border-top-width: 1px;
`;

const SummaryRow = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
`;

const SummaryDivider = styled(View)`
  height: 1px;
  margin: 8px 0;
`;

const CheckoutBtn = styled(
  TouchableOpacity,
)`
  height: 54px;
  border-radius: 14px;
  padding: 0 18px;
  justify-content: center;
  margin-bottom: 8px;
`;

const CheckoutBtnInner = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const CheckoutAmountRow = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 2px;
`;

const PayBtnLabel = styled.Text`
  font-size: 16px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const PayBtnAmountText = styled.Text`
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const PickerSheet = styled(SafeAreaView)`
  max-height: 75%;
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  padding: 8px 0 4px;
`;

const PickerHandle = styled(View)`
  width: 40px;
  height: 4px;
  border-radius: 2px;
  align-self: center;
  margin: 4px 0 10px;
`;

const PickerTitle = styled.Text`
  padding: 0 20px 8px;
  font-size: 16px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const PickerItem = styled(
  TouchableOpacity,
)`
  flex-direction: row;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  border-bottom-width: 1px;
`;