/**
 * user.js — tracks the simulated household's age and RMD eligibility.
 *
 * Holds the user's current age, month-within-year, and anchored birth year,
 * and computes the Required Minimum Distribution (RMD) starting age under
 * SECURE 2.0 rules.
 */

export class User {
    constructor(age, birthYear) {
        this.age = age;
        this.month = 0;
        this.birthYear = birthYear ?? (new Date().getFullYear() - age);
    }

    addMonths(additionalMonths) {
        if (additionalMonths >= 0) {
            this.month += additionalMonths;
            while (this.month >= 12) {
                this.age += Math.floor(this.month / 12);
                this.month = this.month % 12;
            }
        } else {
            console.error("Additional months must be a non-negative value.");
        }
    }

    addYears(additionalYears) {
        if (additionalYears >= 0) {
            this.age += additionalYears;
        } else {
            console.error("Additional years must be a non-negative value.");
        }
    }

    setAge(newAge) {
        if (newAge >= 0) {
            this.age = newAge;
        } else {
            console.error("Age must be a non-negative value.");
        }
    }

    getAge() {
        return this.age;
    }

    getMonth() {
        return this.month;
    }

    rmdRequired() {
        return this.age >= this.rmdAge();
    }

    /** RMD starting age under SECURE 2.0: 72 (born < 1951), 73 (1951–1959), or 75 (1960+). */
    rmdAge() {
        if (this.birthYear < 1951) return 72;
        if (this.birthYear < 1960) return 73;
        return 75;
    }

}