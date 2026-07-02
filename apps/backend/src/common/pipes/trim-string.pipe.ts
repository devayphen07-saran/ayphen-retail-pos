import { Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class TrimStringPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value === 'string') return value.trim() || null;
    if (value !== null && typeof value === 'object') {
      return this.trimObject(value as Record<string, unknown>);
    }
    return value;
  }

  private trimObject(obj: Record<string, unknown>): Record<string, unknown> {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        obj[key] = v.trim() || null;
      } else if (v !== null && typeof v === 'object') {
        obj[key] = this.trimObject(v as Record<string, unknown>);
      }
    }
    return obj;
  }
}