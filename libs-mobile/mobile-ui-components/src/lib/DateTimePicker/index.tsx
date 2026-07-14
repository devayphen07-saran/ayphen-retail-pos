import { useState } from "react";
import {
  Platform,
  Modal,
  View,
  Button,
  TouchableOpacity,
} from "react-native";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import styled, { useTheme } from "styled-components/native";
import {
  Controller,
  Control,
  FieldValues,
  Path,
  RegisterOptions,
} from "react-hook-form";
import { Typography } from "../typography";
import { X, Clock } from "lucide-react-native";
import { Flex, Row } from "../layout";

interface DatePickerProps<T extends FieldValues = FieldValues> {
  value?: Date;
  onChange?: (date?: Date) => void;
  label?: string;
  placeholder?: string;
  name?: Path<T>;
  rules?: RegisterOptions<T, Path<T>>;
  control?: Control<T>;
  errorMessage?: string;
  required?: boolean;
  disabled?: boolean;
  minimumDate?: Date;
  maximumDate?: Date;
  showTime?: boolean;
}

export function DateTimeField<T extends FieldValues = FieldValues>({
  value,
  onChange,
  label,
  placeholder = "Select a date",
  name,
  control,
  errorMessage,
  required = false,
  disabled = false,
  minimumDate,
  maximumDate,
  showTime = false,
  rules,
}: DatePickerProps<T>) {
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<"date" | "time">("date");
  const [internalDate, setInternalDate] = useState<Date | undefined>(value);
  const [tempDate, setTempDate] = useState<Date | undefined>(value);
  const theme = useTheme();
  const handleChange = (newDate?: Date, changeFn?: (d?: Date) => void) => {
    setInternalDate(newDate);
    if (changeFn) {
      changeFn(newDate);
    } else {
      onChange?.(newDate);
    }
  };

  const handleConfirm = (changeFn: (date?: Date) => void) => {
    handleChange(tempDate, changeFn);
    setShow(false);
    setMode("date");
  };

  const renderPicker = (
    val: Date | undefined,
    changeFn: (date?: Date) => void
  ) => (
    <Flex flex={1}>
      {label && (
        <LabelContainer>
          <Typography.Caption>
            {label}
            {required && (
              <RequiredMark type="secondary">{" *"}</RequiredMark>
            )}
          </Typography.Caption>
        </LabelContainer>
      )}

      <SelectTouchable
        disabled={disabled}
        onPress={() => !disabled && setShow(true)}
        $disabled={disabled}
      >
        <TextRow>
          <ValueText type="secondary" numberOfLines={1}>
            {val
              ? showTime
                ? val.toLocaleString()
                : val.toLocaleDateString()
              : placeholder}
          </ValueText>

          {val && !disabled && (
            <TouchableOpacity
              onPress={() => handleChange(undefined, changeFn)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <X size={18} color={theme.colorTextSecondary} />
            </TouchableOpacity>
          )}
        </TextRow>
      </SelectTouchable>

      {errorMessage && <ErrorText>{errorMessage}</ErrorText>}

      {!disabled && show && (
        <Modal transparent animationType="fade">
          <Backdrop onPress={() => setShow(false)} />
          <PickerContainer>
            {mode === "date" && (
              <>
                <SectionLabel>Select Date</SectionLabel>
                <DateTimePicker
                  value={tempDate || new Date()}
                  mode="date"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  minimumDate={minimumDate}
                  maximumDate={maximumDate}
                  onChange={(
                    event: DateTimePickerEvent,
                    selectedDate?: Date
                  ) => {
                    if (event.type === "set" && selectedDate) {
                      setTempDate(selectedDate);
                    }
                  }}
                />

                {showTime && (
                  <TimeToggleButton onPress={() => setMode("time")}>
                    <Clock size={18} color={theme.colorPrimary} />
                    <TimeToggleLabel>Select Time</TimeToggleLabel>
                  </TimeToggleButton>
                )}

                <DoneButtonContainer>
                  <Button
                    title="Done"
                    onPress={() => handleConfirm(changeFn)}
                  />
                </DoneButtonContainer>
              </>
            )}

            {mode === "time" && (
              <>
                <SectionLabel>Select Time</SectionLabel>
                <DateTimePicker
                  value={tempDate || new Date()}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onChange={(
                    event: DateTimePickerEvent,
                    selectedTime?: Date
                  ) => {
                    if (event.type === "set" && selectedTime && tempDate) {
                      const finalDate = new Date(tempDate);
                      finalDate.setHours(selectedTime.getHours());
                      finalDate.setMinutes(selectedTime.getMinutes());
                      setTempDate(finalDate);
                    }
                  }}
                />

                <ConfirmRow>
                  <Button
                    title="Back to Date"
                    onPress={() => setMode("date")}
                  />
                  <Button
                    title="Confirm"
                    onPress={() => handleConfirm(changeFn)}
                  />
                </ConfirmRow>
              </>
            )}
          </PickerContainer>
        </Modal>
      )}
    </Flex>
  );

  if (name && control) {
    return (
      <Controller
        name={name}
        control={control}
        rules={rules}
        render={({ field: { value: fieldValue, onChange: fieldOnChange } }) => {
          const handleBothChanges = (date?: Date) => {
            setInternalDate(date);
            fieldOnChange(date);
            onChange?.(date);
          };
          const currentValue = fieldValue ?? internalDate;
          return renderPicker(currentValue, handleBothChanges);
        }}
      />
    );
  }

  return renderPicker(internalDate, handleChange);
}

const SelectTouchable = styled(TouchableOpacity)<{ $disabled?: boolean }>`
  padding: ${({ theme }) =>
    Platform.OS === "ios" ? theme.padding.small : theme.padding.xSmall}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorder};
  margin-bottom: ${({ theme }) => theme.margin.small}px;
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};
`;

const TextRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
`;

const Backdrop = styled.TouchableOpacity`
  flex: 1;
  background-color: ${({ theme }) => theme.overlay.scrimSoft};
  justify-content: flex-end;
`;

const PickerContainer = styled(View)`
  background-color: ${({ theme }) => theme.colorBgElevated};
  border-top-left-radius: ${({ theme }) =>
    theme.borderRadius.xLarge + theme.borderRadius.small}px;
  border-top-right-radius: ${({ theme }) =>
    theme.borderRadius.xLarge + theme.borderRadius.small}px;
  padding: ${({ theme }) => theme.sizing.medium}px;
`;

const LabelContainer = styled.View`
  padding-bottom: ${({ theme }) => theme.sizing.xxSmall}px;
  margin-left: ${({ theme }) => theme.sizing.xxSmall}px;
`;

const RequiredMark = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorError};
`;

const ValueText = styled(Typography.Body)`
  flex: 1;
`;

const ErrorText = styled(Typography.Caption)`
  color: ${({ theme }) => theme.colorError};
`;

const SectionLabel = styled(Typography.Body)`
  margin-bottom: ${({ theme }) => theme.sizing.xSmall}px;
`;

const TimeToggleButton = styled(TouchableOpacity)`
  margin-top: ${({ theme }) => theme.sizing.small}px;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.sizing.xSmall}px;
  padding-vertical: ${({ theme }) => theme.sizing.xSmall}px;
`;

const TimeToggleLabel = styled(Typography.Body)`
  color: ${({ theme }) => theme.colorPrimary};
  font-weight: ${({ theme }) => theme.fontWeight['500']};
`;

const DoneButtonContainer = styled.View`
  margin-top: ${({ theme }) => theme.sizing.small}px;
`;

const ConfirmRow = styled(Row)`
  margin-top: ${({ theme }) => theme.sizing.small}px;
  justify-content: space-between;
`;
