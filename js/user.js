export class User {
    constructor(age) {
        this.age = age;
        this.month = 0;
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
        return this.age >= 73;
    }

}