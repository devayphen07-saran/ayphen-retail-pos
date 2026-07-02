import { View } from 'react-native';
import styled from 'styled-components/native';

import { Typography } from '../typography';

export const FormSection = styled(View)`
  padding: ${({ theme }) => theme.sizing.regular}px
    ${({ theme }) => theme.sizing.medium}px
    ${({ theme }) => theme.sizing.zero}px;
`;

export const FormSectionLabel = styled(Typography.Caption)`
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: ${({ theme }) => theme.colorTextTertiary};
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

export const FormInputWrapper = styled(View)`
  padding: ${({ theme }) => theme.sizing.small}px
    ${({ theme }) => theme.sizing.medium}px;
  gap: 6px;
`;

export const FormBottomSpacer = styled(View)`
  height: 40px;
`;

export const FormFieldHint = styled(Typography.Caption)`
  font-size: 11px;
  color: ${({ theme }) => theme.colorTextTertiary};
`;
