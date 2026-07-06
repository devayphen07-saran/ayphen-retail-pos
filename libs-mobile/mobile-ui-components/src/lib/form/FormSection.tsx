import { View } from 'react-native';
import styled from 'styled-components/native';

import { Typography } from '../typography';

export const FormSection = styled(View)`
  padding: ${({ theme }) => theme.sizing.regular}px
    ${({ theme }) => theme.sizing.medium}px
    ${({ theme }) => theme.sizing.zero}px;
`;

export const FormSectionLabel = styled(Typography.Caption)`
  font-size: ${({ theme }) => theme.fontSize.xSmall}px;
  font-weight: ${({ theme }) => theme.fontWeight['700']};
  letter-spacing: 1.2px;
  color: ${({ theme }) => theme.colorTextTertiary};
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

export const FormInputWrapper = styled(View)`
  padding: ${({ theme }) => theme.sizing.small}px
    ${({ theme }) => theme.sizing.medium}px;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;

export const FormBottomSpacer = styled(View)`
  height: ${({ theme }) => theme.sizing.xxLarge}px;
`;

export const FormFieldHint = styled(Typography.Caption)`
  font-size: ${({ theme }) => theme.fontSize.xSmall}px;
  color: ${({ theme }) => theme.colorTextTertiary};
`;
