import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({ message: 'Validation failed', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    return r.data;
  }
}
