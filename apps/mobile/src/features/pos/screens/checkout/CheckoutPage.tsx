import { useRef, type ReactElement } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import {
  LucideIcon,
  type LucideIconNameType,
} from '@ayphen/mobile-ui-components';

import type { LocalCustomer } from '@core/sync/repositories/customer.repository';
import type { LocalPaymentAccount } from '@core/sync/repositories/payment-account.repository';

import { formatAmount } from './format';

function accountIcon(kind: string | null): LucideIconNameType {
  switch (kind) {
    case 'cash':
      return 'Banknote';

    case 'card':
      return 'CreditCard';

    case 'upi':
      return 'Smartphone';

    case 'wallet':
      return 'Wallet';

    case 'bank':
      return 'Landmark';

    default:
      return 'CircleDollarSign';
  }
}

function accountDescription(kind: string | null): string {
  switch (kind) {
    case 'cash':
      return 'Collect cash';

    case 'card':
      return 'Debit or credit card';

    case 'upi':
      return 'UPI payment';

    case 'wallet':
      return 'Prepaid wallet';

    case 'bank':
      return 'Bank transfer';

    default:
      return 'Other tender';
  }
}

export interface CheckoutPageProps {
  totalPaise: number;
  accounts: LocalPaymentAccount[];
  creditEnabled: boolean;
  selectedCustomer?: LocalCustomer;
  submitting?: boolean;
  onBack: () => void;
  onEditCart: () => void;
  onSelectAccount: (account: LocalPaymentAccount) => void;
  onSelectCredit: () => void;
}

export function CheckoutPage({
  totalPaise,
  accounts,
  creditEnabled,
  selectedCustomer,
  submitting = false,
  onBack,
  onEditCart,
  onSelectAccount,
  onSelectCredit,
}: CheckoutPageProps): ReactElement {
  const { theme } = useMobileTheme();

  /*
   * The cart is cleared when the mutation succeeds. Preserve the last positive
   * total so checkout cannot flash ₹0 before the success view renders.
   */
  const shownTotalRef = useRef(totalPaise);

  if (totalPaise > 0) {
    shownTotalRef.current = totalPaise;
  }

  const shownTotal = shownTotalRef.current;

  return (
    <Root
      style={{
        backgroundColor: theme.colorBgLayout,
      }}
    >
      <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
        <Header
          style={{
            backgroundColor: theme.colorBgContainer,
            borderBottomColor: theme.colorBorderSecondary,
          }}
        >
          <BackButton
            onPress={onBack}
            disabled={submitting}
            hitSlop={12}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel="Back to cart"
            style={{
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <LucideIcon name="ArrowLeft" size={20} color={theme.colorText} />
          </BackButton>

          <HeaderTitle
            style={{
              color: theme.colorText,
            }}
          >
            Checkout
          </HeaderTitle>

          <EditCartButton
            onPress={onEditCart}
            disabled={submitting}
            hitSlop={8}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Edit cart"
            style={{
              opacity: submitting ? 0.5 : 1,
            }}
          >
            <EditCartText
              style={{
                color: theme.colorPrimary,
              }}
            >
              Edit cart
            </EditCartText>
          </EditCartButton>
        </Header>

        <ScrollView
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.body}
        >
          <AmountCard
            style={{
              backgroundColor: theme.colorPrimary,
            }}
          >
            <AmountLabel>Total payable</AmountLabel>

            <AmountRow>
              <CurrencySymbol>₹</CurrencySymbol>

              <AmountNumber
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.5}
              >
                {formatAmount(shownTotal)}
              </AmountNumber>
            </AmountRow>
          </AmountCard>

          <SectionLabel
            style={{
              color: theme.colorTextSecondary,
            }}
          >
            {submitting ? 'Recording sale…' : 'Select payment method'}
          </SectionLabel>

          <MethodsGrid>
            {accounts.map((account) => (
              <MethodTile
                key={account.id}
                onPress={() => onSelectAccount(account)}
                disabled={submitting}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={`${account.name}, ${accountDescription(account.kind)}`}
                accessibilityState={{
                  disabled: submitting,
                }}
                style={{
                  backgroundColor: theme.colorBgContainer,
                  borderColor: theme.colorBorderSecondary,
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                <IconWrapper
                  style={{
                    backgroundColor: theme.colorPrimaryBg,
                  }}
                >
                  <LucideIcon
                    name={accountIcon(account.kind)}
                    size={18}
                    color={theme.colorPrimary}
                  />
                </IconWrapper>

                <TileTextColumn>
                  <MethodLabel
                    numberOfLines={1}
                    style={{
                      color: theme.colorText,
                    }}
                  >
                    {account.name}
                  </MethodLabel>

                  <MethodDescription
                    numberOfLines={1}
                    style={{
                      color: theme.colorTextTertiary,
                    }}
                  >
                    {accountDescription(account.kind)}
                  </MethodDescription>
                </TileTextColumn>

                <LucideIcon
                  name="ChevronRight"
                  size={16}
                  color={theme.colorTextTertiary}
                />
              </MethodTile>
            ))}
          </MethodsGrid>

          {creditEnabled ? (
            <CreditRow
              onPress={onSelectCredit}
              disabled={submitting}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityLabel={
                selectedCustomer
                  ? `Charge to ${selectedCustomer.name}'s credit account`
                  : 'Select customer for credit'
              }
              accessibilityState={{
                disabled: submitting,
              }}
              style={{
                backgroundColor: theme.colorBgContainer,
                borderColor: selectedCustomer
                  ? theme.colorPrimary
                  : theme.colorBorderSecondary,
                opacity: submitting ? 0.5 : 1,
              }}
            >
              <IconWrapper
                style={{
                  backgroundColor: theme.colorFillSecondary,
                }}
              >
                <LucideIcon
                  name="UserCheck"
                  size={18}
                  color={theme.colorTextSecondary}
                />
              </IconWrapper>

              <CreditTextColumn>
                <MethodLabel
                  numberOfLines={1}
                  style={{
                    color: theme.colorText,
                  }}
                >
                  Customer credit
                </MethodLabel>

                <MethodDescription
                  numberOfLines={1}
                  style={{
                    color: theme.colorTextTertiary,
                  }}
                >
                  {selectedCustomer
                    ? `Add to ${selectedCustomer.name}'s account`
                    : 'Select a customer first'}
                </MethodDescription>
              </CreditTextColumn>

              <LucideIcon
                name="ChevronRight"
                size={16}
                color={theme.colorTextTertiary}
              />
            </CreditRow>
          ) : null}

          {accounts.length === 0 && !creditEnabled ? (
            <EmptyMethods>
              <LucideIcon
                name="CircleDollarSign"
                size={28}
                color={theme.colorTextTertiary}
              />
              <EmptyMethodsText
                style={{
                  color: theme.colorTextSecondary,
                }}
              >
                Add a payment account or customer before checking out.
              </EmptyMethodsText>
            </EmptyMethods>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </Root>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  body: {
    paddingBottom: 32,
  },
});

const Root = styled(View)`
  flex: 1;
`;

const Header = styled(View)`
  flex-direction: row;
  align-items: center;
  padding: 12px 16px;
  border-bottom-width: 1px;
`;

const BackButton = styled(TouchableOpacity)`
  width: 36px;
  height: 36px;
  border-radius: 18px;
  align-items: center;
  justify-content: center;
`;

const HeaderTitle = styled.Text`
  flex: 1;
  font-size: 17px;
  font-weight: 600;
  text-align: center;
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
`;

const EditCartButton = styled(TouchableOpacity)`
  width: 60px;
  align-items: flex-end;
`;

const EditCartText = styled.Text`
  font-size: 14px;
  font-weight: 500;
  font-family: ${({ theme }) => theme.fontFamily.poppinsMedium};
`;

const AmountCard = styled(View)`
  margin: 16px 16px 0;
  border-radius: 16px;
  padding: 20px 22px 22px;
`;

const AmountLabel = styled.Text`
  margin-bottom: 8px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.3px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;

const AmountRow = styled(View)`
  flex-direction: row;
  align-items: baseline;
`;

const CurrencySymbol = styled.Text`
  margin-right: 4px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 28px;
  font-weight: 700;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;

const AmountNumber = styled.Text`
  color: #ffffff;
  font-size: 40px;
  font-weight: 800;
  line-height: 48px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;

const SectionLabel = styled.Text`
  padding: 20px 20px 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
`;

const MethodsGrid = styled(View)`
  flex-direction: row;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 16px;
`;

const MethodTile = styled(TouchableOpacity)`
  flex-grow: 1;
  flex-basis: 46%;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border-width: 1px;
`;

const TileTextColumn = styled(View)`
  flex: 1;
`;

const IconWrapper = styled(View)`
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  align-items: center;
  justify-content: center;
`;

const MethodLabel = styled.Text`
  font-size: 14px;
  font-weight: 600;
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
`;

const MethodDescription = styled.Text`
  margin-top: 1px;
  font-size: 10.5px;
  font-weight: 400;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;

const CreditRow = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  gap: 12px;
  margin: 10px 16px 0;
  padding: 14px;
  border-radius: 12px;
  border-width: 1px;
`;

const CreditTextColumn = styled(View)`
  flex: 1;
`;

const EmptyMethods = styled(View)`
  align-items: center;
  gap: 8px;
  margin: 24px 16px;
  padding: 24px;
`;

const EmptyMethodsText = styled.Text`
  text-align: center;
  font-size: 13px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;
