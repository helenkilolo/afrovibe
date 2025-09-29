// seed.js - Script to seed the database with quiz questions

const mongoose = require('mongoose');
const Quiz = require('./models/Quiz'); // Adjust the path if needed

// Replace with your MongoDB connection string
const mongoURI = 'mongodb://localhost:27017/afrovibe_db';

const quizzes = [
  {
    question: "Which country is the largest in Africa by area?",
    options: ["Algeria", "Democratic Republic of Congo", "Sudan", "Libya"],
    correctAnswer: "Algeria",
    category: "Geography"
  },
  {
    question: "What is the largest lake in Africa?",
    options: ["Lake Victoria", "Lake Tanganyika", "Lake Malawi", "Lake Chad"],
    correctAnswer: "Lake Victoria",
    category: "Geography"
  },
  {
    question: "Which of the following is not a member of the 'Big Five' African safari animals?",
    options: ["Lion", "Leopard", "Cheetah", "Buffalo"],
    correctAnswer: "Cheetah",
    category: "Culture"
  },
  {
    question: "The ancient city of Timbuktu is located in which modern-day country?",
    options: ["Mali", "Egypt", "Ethiopia", "Nigeria"],
    correctAnswer: "Mali",
    category: "History"
  },
  {
    question: "Who is known as the 'King of Afrobeat'?",
    options: ["Fela Kuti", "Burna Boy", "Wizkid", "Davido"],
    correctAnswer: "Fela Kuti",
    category: "Music"
  },
  {
    question: "What is the official currency of Nigeria?",
    options: ["Cedi", "Naira", "Rand", "Shilling"],
    correctAnswer: "Naira",
    category: "Geography"
  },
  {
    question: "Which African country is famous for the pyramids of Giza?",
    options: ["Egypt", "Sudan", "Ethiopia", "Tunisia"],
    correctAnswer: "Egypt",
    category: "History"
  },
  {
    question: "What is the most widely spoken language in Africa?",
    options: ["Arabic", "Swahili", "Hausa", "Yoruba"],
    correctAnswer: "Swahili",
    category: "Culture"
  },
  {
    question: "Which African country is the origin of the traditional music style 'Amapiano'?",
    options: ["South Africa", "Ghana", "Nigeria", "Kenya"],
    correctAnswer: "South Africa",
    category: "Music"
  }
];

async function seedDB() {
  try {
    await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('MongoDB connected successfully');
    
    for (const quiz of quizzes) {
      const existingQuiz = await Quiz.findOne({ question: quiz.question });
      if (!existingQuiz) {
        await Quiz.create(quiz);
        console.log(`Added quiz: ${quiz.question}`);
      } else {
        console.log(`Skipped existing quiz: ${quiz.question}`);
      }
    }
    
    console.log('Database seeding complete!');
  } catch (err) {
    console.error('Error seeding database:', err);
  } finally {
    await mongoose.connection.close();
  }
}

seedDB();
