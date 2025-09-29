// models/Quiz.js - New Mongoose model for quiz questions

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const quizSchema = new Schema({
    question: {
        type: String,
        required: true,
        trim: true,
        maxlength: 250
    },
    options: {
        type: [String],
        required: true
    },
    correctAnswer: {
        type: String,
        required: true
    },
    category: {
        type: String,
        enum: ['Music', 'History', 'Geography', 'Culture'],
        required: true
    }
});

const Quiz = mongoose.model('Quiz', quizSchema);

module.exports = Quiz;
