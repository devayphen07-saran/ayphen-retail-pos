import { useRef, type ReactElement } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { LucideIcon } from '@ayphen/mobile-ui-components';

import { formatPaise } from './format';

export interface PaymentSuccessPageProps {
  totalPaise: number;
  methodLabel: string;
  tenderedPaise?: number;
  changePaise?: number;

  /**
   * True when the mutation was queued offline and has not necessarily reached
   * the server yet.
   */
  offline?: boolean;

  onNewSale: () => void;
  onPrint: () => void;
  onShare: () => void;
}

export function PaymentSuccessPage({
  totalPaise,
  methodLabel,
  tenderedPaise,
  changePaise,
  offline = false,
  onNewSale,
  onPrint,
  onShare,
}: PaymentSuccessPageProps): ReactElement {
  const { theme } = useMobileTheme();

  /*
   * Capture the completion time once. Re-renders must not change the time shown
   * on the receipt.
   */
  const completedAtRef = useRef(
    new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }),
  );

  return (
    <Root
      style={{
        backgroundColor: theme.colorBgLayout,
      }}
    >
      <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ContentArea>
            <CheckCircle
              style={{
                backgroundColor: theme.colorSuccessBg,
              }}
            >
              <LucideIcon name="Check" size={44} color={theme.colorSuccess} />
            </CheckCircle>

            <SuccessTitle
              accessibilityRole="header"
              style={{
                color: theme.colorText,
              }}
            >
              Payment complete
            </SuccessTitle>

            <SuccessSubtitle
              style={{
                color: theme.colorTextSecondary,
              }}
            >
              {tenderedPaise !== undefined
                ? `${methodLabel} · ${formatPaise(tenderedPaise)} tendered`
                : methodLabel}
            </SuccessSubtitle>

            <InvoiceMetadata
              style={{
                color: theme.colorTextTertiary,
              }}
            >
              {offline
                ? `Saved offline · ${completedAtRef.current} · will sync`
                : completedAtRef.current}
            </InvoiceMetadata>

            <ReceiptCard
              style={{
                backgroundColor: theme.colorBgContainer,
                borderColor: theme.colorBorderSecondary,
              }}
            >
              <ReceiptRow>
                <ReceiptLabel
                  style={{
                    color: theme.colorTextSecondary,
                  }}
                >
                  Total collected
                </ReceiptLabel>

                <ReceiptValue
                  style={{
                    color: theme.colorText,
                  }}
                >
                  {formatPaise(totalPaise)}
                </ReceiptValue>
              </ReceiptRow>

              {changePaise !== undefined && changePaise > 0 ? (
                <>
                  <ReceiptDivider
                    style={{
                      backgroundColor: theme.colorBorderSecondary,
                    }}
                  />

                  <ReceiptRow>
                    <ReceiptLabel
                      style={{
                        color: theme.colorTextSecondary,
                      }}
                    >
                      Change returned
                    </ReceiptLabel>

                    <ReceiptChangeValue
                      style={{
                        color: theme.colorSuccess,
                      }}
                    >
                      {formatPaise(changePaise)}
                    </ReceiptChangeValue>
                  </ReceiptRow>
                </>
              ) : null}
            </ReceiptCard>
          </ContentArea>
        </ScrollView>

        <ActionArea>
          <ActionRow>
            <ActionOutlineButton
              onPress={onPrint}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Print receipt"
              style={{
                borderColor: theme.colorBorderSecondary,
              }}
            >
              <LucideIcon
                name="Printer"
                size={18}
                color={theme.colorTextSecondary}
              />

              <ActionOutlineLabel
                style={{
                  color: theme.colorText,
                }}
              >
                Print
              </ActionOutlineLabel>
            </ActionOutlineButton>

            <ActionOutlineButton
              onPress={onShare}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Share receipt"
              style={{
                borderColor: theme.colorBorderSecondary,
              }}
            >
              <LucideIcon
                name="Share2"
                size={18}
                color={theme.colorTextSecondary}
              />

              <ActionOutlineLabel
                style={{
                  color: theme.colorText,
                }}
              >
                Share
              </ActionOutlineLabel>
            </ActionOutlineButton>
          </ActionRow>

          <NewSaleButton
            onPress={onNewSale}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Start new sale"
            style={{
              backgroundColor: theme.colorPrimary,
            }}
          >
            <LucideIcon name="Plus" size={18} color={theme.colorWhite} />

            <NewSaleLabel>New sale</NewSaleLabel>
          </NewSaleButton>
        </ActionArea>
      </SafeAreaView>
    </Root>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
});

const Root = styled(View)`
  flex: 1;
`;

const ContentArea = styled(View)`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
`;

const CheckCircle = styled(View)`
  width: 88px;
  height: 88px;
  border-radius: 44px;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
`;

const SuccessTitle = styled.Text`
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;

const SuccessSubtitle = styled.Text`
  margin-top: 6px;
  font-size: 14px;
  text-align: center;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;

const InvoiceMetadata = styled.Text`
  margin-top: 4px;
  font-size: 12px;
  text-align: center;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;

const ReceiptCard = styled(View)`
  width: 100%;
  margin-top: 28px;
  padding: 0 18px;
  border-radius: 14px;
  border-width: 1px;
`;

const ReceiptRow = styled(View)`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
`;

const ReceiptDivider = styled(View)`
  height: 1px;
`;

const ReceiptLabel = styled.Text`
  font-size: 14px;
  font-family: ${({ theme }) => theme.fontFamily.poppinsRegular};
`;

const ReceiptValue = styled.Text`
  font-size: 17px;
  font-weight: 800;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;

const ReceiptChangeValue = styled.Text`
  font-size: 15px;
  font-weight: 700;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;

const ActionArea = styled(View)`
  gap: 10px;
  padding: 14px 16px 12px;
`;

const ActionRow = styled(View)`
  flex-direction: row;
  gap: 10px;
`;

const ActionOutlineButton = styled(TouchableOpacity)`
  flex: 1;
  height: 48px;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  border-width: 1.5px;
`;

const ActionOutlineLabel = styled.Text`
  font-size: 14px;
  font-weight: 600;
  font-family: ${({ theme }) => theme.fontFamily.poppinsSemiBold};
`;

const NewSaleButton = styled(TouchableOpacity)`
  height: 52px;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 14px;
`;

const NewSaleLabel = styled.Text`
  color: #ffffff;
  font-size: 16px;
  font-weight: 700;
  font-family: ${({ theme }) => theme.fontFamily.poppinsBold};
`;
