import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import {
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import styled from 'styled-components/native';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { LucideIcon } from '@ayphen/mobile-ui-components';

import { formatPaise } from './format';

const KEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '.',
  '0',
  'back',
] as const;

type NumpadKey = (typeof KEYS)[number];

export interface CashPaymentPageProps {
  totalPaise: number;
  submitting?: boolean;
  onBack: () => void;
  onTender: (
    tenderedPaise: number,
    changePaise: number,
  ) => void;
}

function roundUpToMultiple(
  value: number,
  multiple: number,
): number {
  return Math.ceil(value / multiple) * multiple;
}

/**
 * Return exact and rounded-up suggestions in paise.
 */
function getQuickAmounts(
  totalPaise: number,
): number[] {
  if (
    !Number.isSafeInteger(totalPaise) ||
    totalPaise <= 0
  ) {
    return [];
  }

  const candidates = new Set<number>([
    totalPaise,
  ]);

  for (const multiple of [
    1_000,
    2_000,
    5_000,
    10_000,
  ]) {
    const rounded = roundUpToMultiple(
      totalPaise,
      multiple,
    );

    if (
      Number.isSafeInteger(rounded) &&
      rounded >= totalPaise
    ) {
      candidates.add(rounded);
    }
  }

  for (const denomination of [
    20_000,
    50_000,
    100_000,
    200_000,
  ]) {
    if (denomination >= totalPaise) {
      candidates.add(denomination);
    }
  }

  return [...candidates]
    .sort((a, b) => a - b)
    .slice(0, 7);
}

function paiseToInput(
  amountPaise: number,
): string {
  const rupees = Math.floor(
    amountPaise / 100,
  );
  const paise = amountPaise % 100;

  return `${rupees}.${String(paise).padStart(2, '0')}`;
}

function parseInputToPaise(
  input: string,
): number | null {
  if (
    !/^\d+(?:\.\d{0,2})?$/.test(input)
  ) {
    return null;
  }

  const [rupeesPart, paisePart = ''] =
    input.split('.');

  const rupees = Number(rupeesPart);
  const paise = Number(
    paisePart.padEnd(2, '0'),
  );

  const total = rupees * 100 + paise;

  return Number.isSafeInteger(total)
    ? total
    : null;
}

export function CashPaymentPage({
  totalPaise,
  submitting = false,
  onBack,
  onTender,
}: CashPaymentPageProps): ReactElement {
  const { theme } = useMobileTheme();
  const [input, setInput] = useState('');

  const quickAmounts = useMemo(
    () => getQuickAmounts(totalPaise),
    [totalPaise],
  );

  const tenderedPaise = useMemo(() => {
    if (!input) {
      return totalPaise;
    }

    return parseInputToPaise(input) ?? 0;
  }, [input, totalPaise]);

  const remainingPaise = Math.max(
    totalPaise - tenderedPaise,
    0,
  );

  const changePaise = Math.max(
    tenderedPaise - totalPaise,
    0,
  );

  const displayAmount =
    input || paiseToInput(totalPaise);

  const canTender =
    !submitting &&
    Number.isSafeInteger(totalPaise) &&
    totalPaise > 0 &&
    Number.isSafeInteger(tenderedPaise) &&
    tenderedPaise >= totalPaise;

  const handleKey = useCallback(
    (key: NumpadKey) => {
      if (submitting) {
        return;
      }

      if (key === 'back') {
        setInput((previous) =>
          previous.slice(0, -1),
        );
        return;
      }

      if (key === '.') {
        setInput((previous) => {
          if (previous.includes('.')) {
            return previous;
          }

          return previous
            ? `${previous}.`
            : '0.';
        });
        return;
      }

      setInput((previous) => {
        if (previous.length >= 12) {
          return previous;
        }

        if (previous === '0') {
          return key === '0'
            ? previous
            : key;
        }

        const next = `${previous}${key}`;
        const decimal =
          next.split('.')[1];

        if (
          decimal !== undefined &&
          decimal.length > 2
        ) {
          return previous;
        }

        return next;
      });
    },
    [submitting],
  );

  const handleTender = useCallback(() => {
    if (!canTender) {
      return;
    }

    onTender(
      tenderedPaise,
      changePaise,
    );
  }, [
    canTender,
    changePaise,
    onTender,
    tenderedPaise,
  ]);

  return (
    <Root
      style={{
        backgroundColor:
          theme.colorBgLayout,
      }}
    >
      <SafeAreaView
        style={styles.fill}
        edges={['top', 'bottom']}
      >
        <Header
          style={{
            backgroundColor:
              theme.colorPrimary,
          }}
        >
          <TouchableOpacity
            onPress={onBack}
            disabled={submitting}
            hitSlop={10}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Back to payment methods"
          >
            <LucideIcon
              name="ArrowLeft"
              size={22}
              color={theme.colorWhite}
            />
          </TouchableOpacity>

          <HeaderTitle numberOfLines={1}>
            Amount to pay:{' '}
            {formatPaise(totalPaise)}
          </HeaderTitle>

          <View style={styles.headerSpacer} />
        </Header>

        <ScrollView
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={
            styles.body
          }
        >
          <AmountSection
            style={{
              backgroundColor:
                theme.colorBgContainer,
            }}
          >
            <AmountMethodLabel
              style={{
                color:
                  theme.colorTextSecondary,
              }}
            >
              Cash (₹)
            </AmountMethodLabel>

            <AmountNumber
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
              style={{
                color: theme.colorText,
              }}
            >
              {displayAmount}
            </AmountNumber>

            {changePaise > 0 ? (
              <AmountStatus
                style={{
                  color:
                    theme.colorSuccess,
                }}
              >
                Change to return{' '}
                {formatPaise(
                  changePaise,
                )}
              </AmountStatus>
            ) : remainingPaise > 0 ? (
              <AmountStatus
                style={{
                  color: theme.colorError,
                }}
              >
                Still remaining{' '}
                {formatPaise(
                  remainingPaise,
                )}
              </AmountStatus>
            ) : (
              <AmountStatus
                style={{
                  color:
                    theme.colorTextTertiary,
                }}
              >
                Exact amount
              </AmountStatus>
            )}
          </AmountSection>

          <SectionDivider
            style={{
              backgroundColor:
                theme.colorBorderSecondary,
            }}
          />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={
              false
            }
            contentContainerStyle={
              styles.quickBar
            }
            style={{
              backgroundColor:
                theme.colorBgContainer,
            }}
          >
            {quickAmounts.map(
              (amountPaise) => {
                const selected =
                  input
                    ? tenderedPaise ===
                      amountPaise
                    : amountPaise ===
                      totalPaise;

                return (
                  <QuickChip
                    key={amountPaise}
                    onPress={() =>
                      setInput(
                        paiseToInput(
                          amountPaise,
                        ),
                      )
                    }
                    disabled={submitting}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel={`Tender ${formatPaise(amountPaise)}`}
                    accessibilityState={{
                      selected,
                      disabled:
                        submitting,
                    }}
                    style={{
                      backgroundColor:
                        selected
                          ? theme.colorPrimary
                          : theme.colorBgLayout,
                      borderColor:
                        selected
                          ? theme.colorPrimary
                          : theme.colorBorder,
                      opacity:
                        submitting
                          ? 0.5
                          : 1,
                    }}
                  >
                    <QuickChipText
                      style={{
                        color: selected
                          ? theme.colorWhite
                          : theme.colorText,
                      }}
                    >
                      {formatPaise(
                        amountPaise,
                      )}
                    </QuickChipText>
                  </QuickChip>
                );
              },
            )}
          </ScrollView>

          <SectionDivider
            style={{
              backgroundColor:
                theme.colorBorderSecondary,
            }}
          />

          <NumpadGrid
            style={{
              backgroundColor:
                theme.colorBgContainer,
            }}
          >
            {KEYS.map((key) => (
              <NumKey
                key={key}
                onPress={() =>
                  handleKey(key)
                }
                disabled={submitting}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={
                  key === 'back'
                    ? 'Delete digit'
                    : key === '.'
                      ? 'Decimal point'
                      : key
                }
                style={{
                  borderColor:
                    theme.colorBorderSecondary,
                  opacity: submitting
                    ? 0.5
                    : 1,
                }}
              >
                {key === 'back' ? (
                  <LucideIcon
                    name="Delete"
                    size={22}
                    color={
                      theme.colorTextSecondary
                    }
                  />
                ) : (
                  <NumKeyText
                    style={{
                      color:
                        theme.colorText,
                    }}
                  >
                    {key}
                  </NumKeyText>
                )}
              </NumKey>
            ))}
          </NumpadGrid>
        </ScrollView>

        <Footer
          style={{
            backgroundColor:
              theme.colorBgContainer,
            borderTopColor:
              theme.colorBorderSecondary,
          }}
        >
          <TenderButton
            onPress={handleTender}
            disabled={!canTender}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={
              changePaise > 0
                ? `Tender cash and return ${formatPaise(changePaise)}`
                : 'Tender cash'
            }
            accessibilityState={{
              disabled: !canTender,
            }}
            style={{
              backgroundColor:
                canTender
                  ? theme.colorPrimary
                  : theme.colorFill,
            }}
          >
            <TenderLabel
              style={{
                color: canTender
                  ? theme.colorWhite
                  : theme.colorTextTertiary,
              }}
            >
              {submitting
                ? 'Recording…'
                : changePaise > 0
                  ? `Tender · Return ${formatPaise(changePaise)}`
                  : 'Tender'}
            </TenderLabel>
          </TenderButton>
        </Footer>
      </SafeAreaView>
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
  body: {
    paddingBottom: 8,
  },
  quickBar: {
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});

const Root = styled(View)`
  flex: 1;
`;

const Header = styled(View)`
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
`;

const HeaderTitle = styled.Text`
  flex: 1;
  color: ${({ theme }) =>
    theme.colorWhite};
  font-size: 15px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const AmountSection = styled(View)`
  padding: 24px 20px 20px;
`;

const AmountMethodLabel = styled.Text`
  margin-bottom: 4px;
  font-size: 13px;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsRegular};
`;

const AmountNumber = styled.Text`
  margin-top: 2px;
  font-size: 52px;
  font-weight: 800;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;

const AmountStatus = styled.Text`
  margin-top: 6px;
  font-size: 14px;
  font-style: italic;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsRegular};
`;

const SectionDivider = styled(View)`
  height: 6px;
`;

const QuickChip = styled(
  TouchableOpacity,
)`
  padding: 8px 16px;
  border-radius: 8px;
  border-width: 1px;
`;

const QuickChipText = styled.Text`
  font-size: 14px;
  font-weight: 600;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsSemiBold};
`;

const NumpadGrid = styled(View)`
  flex-direction: row;
  flex-wrap: wrap;
  padding: 8px 10px;
`;

const NumKey = styled(TouchableOpacity)`
  width: 33.333%;
  height: 64px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border-width: 1px;
  margin: 3px 0;
`;

const NumKeyText = styled.Text`
  font-size: 26px;
  font-weight: 500;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsSemiBold};
`;

const Footer = styled(View)`
  padding: 10px 14px 12px;
  border-top-width: 1px;
`;

const TenderButton = styled(
  TouchableOpacity,
)`
  height: 54px;
  border-radius: 14px;
  align-items: center;
  justify-content: center;
`;

const TenderLabel = styled.Text`
  font-size: 16px;
  font-weight: 700;
  font-family: ${({ theme }) =>
    theme.fontFamily.poppinsBold};
`;