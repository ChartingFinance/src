import { positiveBackgroundColor, negativeBackgroundColor } from './html.js';
import { DateInt } from './date-int.js';
import { Currency } from './currency.js';

export function summary_setStartDate(summaryContainerElement, startDateInt) {
    let summaryStartDateElement = summaryContainerElement.querySelector('[name="startDate"]');
    if (startDateInt)
        summaryStartDateElement.value = startDateInt.toHTML();
    else
    summaryStartDateElement.value = '';
}

export function summary_setStartValue(summaryContainerElement, startCurrency) {
    let summaryStartValueElement = summaryContainerElement.querySelector('[name="startValue"]');
    if (startCurrency)
        summaryStartValueElement.value = startCurrency.toHTML();
    else
        summaryStartValueElement.value = '';
}

export function summary_setFinishDate(summaryContainerElement, finishDateInt) {
    let summaryFinishDateElement = summaryContainerElement.querySelector('[name="finishDate"]');
    if (finishDateInt)
        summaryFinishDateElement.value = finishDateInt.toHTML();
    else
        summaryFinishDateElement.value = '';
}

export function summary_setAccruedMonths(summaryContainerElement, accruedMonths) {
    let summaryAccruedMonthsElement = summaryContainerElement.querySelector('[name="totalMonths"]');
    if (accruedMonths)
        summaryAccruedMonthsElement.value = accruedMonths.toString();
    else
        summaryAccruedMonthsElement.value = '';
}

export function summary_setFinishValue(summaryContainerElement, finishCurrency) {
    let summaryFinishValueElement = summaryContainerElement.querySelector('[name="finishValue"]');
    if (finishCurrency)
        summaryFinishValueElement.value = finishCurrency.toHTML();
    else
        summaryFinishValueElement.value = '';
}

export function summary_setAccumulatedValue(summaryContainerElement, accumulatedCurrency) {
    let summaryAccumulatedValueElement = summaryContainerElement.querySelector('[name="accumulatedValue"]');
    if (accumulatedCurrency) {
        summaryAccumulatedValueElement.value = accumulatedCurrency.toHTML();
    }
    else {
        summaryAccumulatedValueElement.value = '';
    }
    summary_setBackgroundColor(summaryContainerElement, accumulatedCurrency);
}

export function summary_setBackgroundColor(summaryContainerElement, accumulatedCurrency) {
    if (accumulatedCurrency && accumulatedCurrency.amount > 0)
        summaryContainerElement.style.backgroundColor = positiveBackgroundColor;
    else if (accumulatedCurrency && accumulatedCurrency.amount < 0)
        summaryContainerElement.style.backgroundColor = negativeBackgroundColor;
    else
        summaryContainerElement.style.backdropFilter = 'white';
}

export function summary_computeCAGR(summaryContainerElement) {
    let summaryStartDateElement = summaryContainerElement.querySelector('[name="startDate"]');
    let summaryStartValueElement = summaryContainerElement.querySelector('[name="startValue"]');
    let summaryFinishDateElement = summaryContainerElement.querySelector('[name="finishDate"]');
    let summaryFinishValueElement = summaryContainerElement.querySelector('[name="finishValue"]');

    let dateStart = DateInt.parse(summaryStartDateElement.value);
    let valueStart = Currency.parse(summaryStartValueElement.value);
    let dateFinish = DateInt.parse(summaryFinishDateElement.value);
    let valueFinish = Currency.parse(summaryFinishValueElement.value);

    let startYearMonth = dateStart.year + ((dateStart.month -1)/12);
    let finishYearMonth = dateFinish.year + ((dateFinish.month -1)/12);
    let years = finishYearMonth - startYearMonth;
    let summaryAnnualReturnRateElement = summaryContainerElement.querySelector('[name="annualReturnRate"]');
    let cagr = 0.0;

    let step1 = (valueFinish.toCurrency() / valueStart.toCurrency());
    let step2 = (1 / years);
    let step3 = Math.pow(step1, step2) - 1;
    cagr = parseFloat(step3.toFixed(4));
    cagr *= 100.0;
    
    summaryAnnualReturnRateElement.value = cagr;
}

export function buildSummary(summaryElement, portfolio) {
        
    summary_setStartDate(summaryElement, portfolio.firstDateInt);
    summary_setStartValue(summaryElement, portfolio.startValue());  
    summary_setFinishDate(summaryElement, portfolio.lastDateInt);
    
    summary_setFinishValue(summaryElement, portfolio.finishValue());
    summary_setAccruedMonths(summaryElement, portfolio.totalMonths);
    summary_setAccumulatedValue(summaryElement, portfolio.accumulatedValue());
    summary_computeCAGR(summaryElement);        

}