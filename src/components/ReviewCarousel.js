import { useRef } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { Navigation } from 'swiper/modules';
import 'swiper/css';
import 'swiper/css/navigation';
import '../styles/ReviewCarousel.css';

function ReviewCarousel() {
  const swiperRef = useRef(null);

  const reviews = [
    {
      id: 1,
      stars: 5,
      text: "Perfect Events NI absolutely made our wedding day unforgettable. The music selection was spot on, and the professionalism was impeccable. Highly recommended!",
      author: "Sarah & James",
      event: "Wedding, Belfast"
    },
    {
      id: 2,
      stars: 5,
      text: "We hired Perfect Events NI for our corporate event and they were brilliant. No cheesy vibes, just sophisticated entertainment that impressed all our clients.",
      author: "Michael O'Brien",
      event: "Corporate Event, Dublin"
    },
    {
      id: 3,
      stars: 5,
      text: "Our birthday party was incredible thanks to Perfect Events NI. They listened to what we wanted and delivered exactly that. Best decision ever!",
      author: "Emma & Friends",
      event: "Private Party, Belfast"
    },
    {
      id: 4,
      stars: 5,
      text: "The PA system and engineering support for our event was top-notch. Professional, reliable, and the sound quality was exceptional. Will definitely book again!",
      author: "David",
      event: "Event, Cork"
    }
  ];

  return (
    <div className="review-carousel-container">
      <Swiper
        ref={swiperRef}
        modules={[Navigation]}
        navigation={{
          nextEl: '.swiper-button-next',
          prevEl: '.swiper-button-prev',
        }}
        spaceBetween={30}
        slidesPerView={2}
        loop={true}
        className="review-swiper"
        breakpoints={{
          0: {
            slidesPerView: 1,
          },
          768: {
            slidesPerView: 2,
          },
        }}
      >
        {reviews.map((review) => (
          <SwiperSlide key={review.id} className="review-slide">
            <div className="review-card">
              <div className="stars">
                {[...Array(review.stars)].map((_, i) => (
                  <span key={i}>⭐</span>
                ))}
              </div>
              <p className="review-text">"{review.text}"</p>
              <p className="review-author">— {review.author}</p>
              <p className="review-event">{review.event}</p>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
      <div className="swiper-button-prev"></div>
      <div className="swiper-button-next"></div>
    </div>
  );
}

export default ReviewCarousel;
